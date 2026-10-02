"""End-to-end RAG flow with retrieval stubbed and DeepSeek mocked at HTTP level:
routing, no-source behaviour, grounding, follow-ups, failures, usage records."""

import asyncio

import httpx
import pytest

import llm
import rag.pipeline as pipeline
from llm import errors
from llm.types import Task
from llm_helpers import FLASH, PRO, Recorder, chunk, completion_json, make_router, settings


class UsagePool:
    """Captures INSERT INTO llm_usage."""

    def __init__(self):
        self.rows = []

    def acquire(self):
        pool = self

        class Ctx:
            async def __aenter__(self_):
                return self_

            async def execute(self_, sql, *args):
                assert "INSERT INTO llm_usage" in sql
                pool.rows.append(args)

            async def __aexit__(self_, *a):
                return False

        return Ctx()


CH = [chunk("s1", 0, "Chlorophyll absorbs red and blue light.", "biology.pdf", 3, "Page 3"),
      chunk("s2", 2, "ATP is produced in mitochondria.", "cells.docx", None, "Section: Energy", sim=0.7)]


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setattr(pipeline, "get_settings", lambda: settings())
    holder = {}

    def install(*script, chunks=CH, **llm_kw):
        rec = Recorder(*script)
        llm.set_router(make_router(rec, **llm_kw))
        holder["calls"] = []

        async def fake_retrieve(pool, workspace_id, query, top_k=None, **kw):
            holder["calls"].append((workspace_id, query, top_k, kw))
            return list(chunks)

        monkeypatch.setattr(pipeline, "retrieve_chunks", fake_retrieve)
        return rec

    yield install, holder
    llm.set_router(None)


def run(coro):
    return asyncio.run(coro)


def ok(text, model=FLASH):
    return httpx.Response(200, json=completion_json(text=text, model=model))


def test_ordinary_question_uses_flash_and_returns_resolved_citations(setup):
    install, holder = setup
    rec = install(ok("Chlorophyll absorbs red and blue light [1]."))
    pool = UsagePool()
    r = run(pipeline.run_rag_pipeline(pool, "ws-A", "What does chlorophyll absorb?", [], user_id=None))
    assert rec.models == [FLASH] and r.task is Task.CHAT
    assert r.grounding == "grounded" and r.route.model_used == FLASH
    c = r.citations[0]
    assert (c.source_name, c.page_number, c.location_label, c.source_id) == ("biology.pdf", 3, "Page 3", "s1")
    assert holder["calls"][0][0] == "ws-A"  # retrieval was scoped to the caller's workspace
    # usage/model recorded
    assert len(pool.rows) == 1 and FLASH in pool.rows[0] and 150 in pool.rows[0]


def test_complex_research_question_routes_to_pro_and_widens_retrieval(setup):
    install, holder = setup
    rec = install(ok("They differ in X [1].", model=PRO))
    r = run(pipeline.run_rag_pipeline(None, "ws-A", "Compare the methodology of both papers and evaluate trade-offs", []))
    assert rec.models == [PRO] and r.task is Task.RESEARCH and r.route.tier.value == "pro"
    assert holder["calls"][0][2] == 12  # 2 x top_k


def test_explicit_task_overrides_classifier(setup):
    install, _ = setup
    rec = install(ok("x [1]."))
    run(pipeline.run_rag_pipeline(None, "ws", "Compare A with B", [], task=Task.STUDY))
    assert rec.models == [FLASH]


def test_nothing_relevant_returns_no_sources_and_never_calls_the_model(setup):
    install, _ = setup
    rec = install(ok("should not be used"), chunks=[])
    r = run(pipeline.run_rag_pipeline(None, "ws-A", "Who won the 1998 World Cup?", []))
    assert rec.requests == []
    assert r.grounding == "no_sources" and r.citations == [] and r.route is None
    assert "could not find an answer" in r.answer


def test_follow_up_question_carries_history_and_document_constraint(setup):
    install, holder = setup
    rec = install(ok("It is made in mitochondria [2]."))
    hist = [{"role": "user", "content": "What is ATP?"}, {"role": "assistant", "content": "An energy molecule."}]
    run(pipeline.run_rag_pipeline(None, "ws-A", "Where is it made?", hist, source_ids=["s2"]))
    sent = rec.requests[0]["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "user"]
    assert "What is ATP?" in sent[1]["content"] and "[2] Source: cells.docx" in sent[3]["content"]
    assert holder["calls"][0][3]["source_ids"] == ["s2"]


def test_hallucinated_reference_is_removed_and_warned(setup):
    install, _ = setup
    install(ok("Fact [1]. Invented fact [5]."))
    r = run(pipeline.run_rag_pipeline(None, "ws", "q?", []))
    assert "[5]" not in r.answer and [c.index for c in r.citations] == [1] and r.warnings


def test_uncited_answer_is_flagged(setup):
    install, _ = setup
    install(ok("Plants are green."))
    r = run(pipeline.run_rag_pipeline(None, "ws", "q?", []))
    assert r.grounding == "uncited" and r.citations == []


def test_model_refusal_has_no_citations(setup):
    install, _ = setup
    install(ok("I could not find an answer in your workspace sources."))
    r = run(pipeline.run_rag_pipeline(None, "ws", "q?", []))
    assert r.grounding == "no_answer" and r.citations == []


def test_provider_failure_surfaces_typed_error_not_a_fabricated_answer(setup):
    install, _ = setup
    install(httpx.Response(503, json={}), max_retries=0)
    with pytest.raises(errors.ProviderOverloadedError):
        run(pipeline.run_rag_pipeline(None, "ws", "q?", []))


def test_missing_llm_key_is_a_clear_error_after_retrieval(setup):
    install, _ = setup
    install(ok("x"), api_key="")
    with pytest.raises(errors.NotConfiguredError):
        run(pipeline.run_rag_pipeline(None, "ws", "q?", []))


def test_embedding_outage_propagates_and_no_model_call_is_made(setup, monkeypatch):
    install, _ = setup
    rec = install(ok("x"))

    async def boom(*a, **k):
        raise errors.EmbeddingUnavailableError("down")

    monkeypatch.setattr(pipeline, "retrieve_chunks", boom)
    with pytest.raises(errors.EmbeddingUnavailableError):
        run(pipeline.run_rag_pipeline(None, "ws", "q?", []))
    assert rec.requests == []


def test_streaming_pipeline_yields_deltas_then_authoritative_result(setup):
    from llm_helpers import sse_body
    install, _ = setup
    install(httpx.Response(200, content=sse_body(["Chlorophyll absorbs light [1]", " and also [9]."])))

    async def collect():
        return [x async for x in pipeline.stream_rag_pipeline(None, "ws", "What absorbs light?", [])]

    items = run(collect())
    assert [k for k, _ in items] == ["delta", "delta", "result"]
    result = items[-1][1]
    assert "[9]" not in result.answer and [c.index for c in result.citations] == [1]
    assert result.route.model_used == FLASH and result.usage.total_tokens == 14


def test_streaming_with_no_sources_yields_only_the_result(setup):
    install, _ = setup
    rec = install(ok("x"), chunks=[])

    async def collect():
        return [x async for x in pipeline.stream_rag_pipeline(None, "ws", "q", [])]

    items = run(collect())
    assert [k for k, _ in items] == ["result"] and rec.requests == []
