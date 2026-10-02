"""Studio generators on the router: JSON validation, source_ref grounding,
no fabricated fallback content."""

import asyncio
import json

import httpx
import pytest

import llm
import rag.generator as gen
from llm import errors
from llm_helpers import FLASH, PRO, Recorder, chunk, completion_json, make_router, settings
from schemas import FlashcardRequest, QuizRequest, ReportRequest, StudyGuideRequest

CH = [chunk("s1", 0, "Chlorophyll absorbs red light.", "biology.pdf", 3, "Page 3"),
      chunk("s2", 1, "ATP powers cells.", "cells.docx", None, None)]


def ok(payload, model=FLASH):
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return httpx.Response(200, json=completion_json(text=text, model=model))


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setattr(gen, "get_settings", lambda: settings())

    def install(*script, chunks=CH, **kw):
        rec = Recorder(*script)
        llm.set_router(make_router(rec, **kw))

        async def fake_retrieve(pool, ws, query, top_k=None, **k):
            return list(chunks)

        async def fake_sample(pool, ws, limit, source_ids=None):
            return list(chunks)

        monkeypatch.setattr(gen, "retrieve_chunks", fake_retrieve)
        monkeypatch.setattr(gen, "sample_chunks", fake_sample)
        return rec

    yield install
    llm.set_router(None)


def run(c):
    return asyncio.run(c)


def test_flashcards_use_flash_json_mode_and_normalise_source_refs(setup):
    rec = setup(ok({"flashcards": [
        {"front": "q1", "back": "a1", "source_ref": "biology.pdf"},
        {"front": "q2", "back": "a2", "source_ref": "BIOLOGY.PDF, p.3"},
        {"front": "q3", "back": "a3", "source_ref": "made-up-book.pdf"},
    ]}))
    r = run(gen.generate_flashcards(None, FlashcardRequest(workspace_id="ws", topic="light", count=5)))
    assert rec.models == [FLASH] and rec.requests[0]["response_format"] == {"type": "json_object"}
    assert [c.source_ref for c in r.flashcards] == ["biology.pdf", "biology.pdf", gen.UNVERIFIED]


def test_flashcards_without_topic_sample_broadly(setup):
    setup(ok({"flashcards": []}))
    r = run(gen.generate_flashcards(None, FlashcardRequest(workspace_id="ws", topic=None, count=3)))
    assert r.flashcards == []


def test_quiz_drops_questions_whose_answer_is_not_an_option(setup):
    setup(ok({"questions": [
        {"question": "good", "options": ["A", "B"], "correct": "A", "explanation": "e", "source_ref": "cells.docx"},
        {"question": "bad", "options": ["A", "B"], "correct": "C", "explanation": "e", "source_ref": "cells.docx"},
    ]}))
    r = run(gen.generate_quiz(None, QuizRequest(workspace_id="ws", topic="t", count=5)))
    assert [q.question for q in r.questions] == ["good"]


def test_quiz_with_no_usable_questions_is_an_error_not_filler(setup):
    setup(ok({"questions": [{"question": "bad", "options": ["A"], "correct": "Z",
                             "explanation": "e", "source_ref": "x"}]}))
    with pytest.raises(errors.MalformedResponseError):
        run(gen.generate_quiz(None, QuizRequest(workspace_id="ws", topic="t")))


def test_invalid_json_and_wrong_shape_raise_malformed(setup):
    setup(ok("this is not json"))
    with pytest.raises(errors.MalformedResponseError):
        run(gen.generate_study_guide(None, StudyGuideRequest(workspace_id="ws", topic="t")))
    setup(ok({"title": "x"}))  # missing sections
    with pytest.raises(errors.MalformedResponseError):
        run(gen.generate_study_guide(None, StudyGuideRequest(workspace_id="ws", topic="t")))


def test_fenced_json_is_accepted(setup):
    setup(ok('```json\n{"title": "T", "sections": [{"heading": "h", "content": "c", "key_terms": []}]}\n```'))
    assert run(gen.generate_study_guide(None, StudyGuideRequest(workspace_id="ws", topic="t"))).title == "T"


def test_nothing_in_workspace_raises_no_relevant_sources_without_calling_model(setup):
    rec = setup(ok({"flashcards": []}), chunks=[])
    with pytest.raises(gen.NoRelevantSourcesError):
        run(gen.generate_flashcards(None, FlashcardRequest(workspace_id="ws", topic="t")))
    assert rec.requests == []


def test_model_outage_is_an_error_not_extractive_filler(setup):
    setup(httpx.Response(503, json={}), max_retries=0)
    with pytest.raises(errors.ProviderOverloadedError):
        run(gen.generate_quiz(None, QuizRequest(workspace_id="ws", topic="t")))


def test_report_uses_pro_strips_bad_citations_and_appends_real_sources(setup):
    rec = setup(ok("Intro [1]. Claim [2]. Bogus [8].", model=PRO))
    r = run(gen.generate_report(None, ReportRequest(workspace_id="ws", title="T", outline_points=["a", "b"])))
    assert rec.models == [PRO]
    md = r.report_markdown
    assert "[8]" not in md and "## Sources" in md
    assert "- [1] biology.pdf, Page 3" in md and "- [2] cells.docx" in md


def test_summary_uses_flash_and_requires_indexed_content(setup, monkeypatch):
    rec = setup(ok({"summary": "S", "key_takeaways": ["k"]}))

    class Pool:
        def __init__(self, rows):
            self.rows = rows

        def acquire(self):
            rows = self.rows

            class Ctx:
                async def __aenter__(self_):
                    return self_

                async def fetch(self_, sql, *a):
                    assert "sc.workspace_id = $1" in sql
                    return rows

                async def __aexit__(self_, *x):
                    return False

            return Ctx()

    from schemas import SummarizeRequest
    req = SummarizeRequest(workspace_id="ws", source_id="s1")
    r = run(gen.summarize_source(Pool([{"content": "alpha beta", "source_name": "n.pdf"}]), req))
    assert (r.summary, r.word_count, r.source_name) == ("S", 2, "n.pdf") and rec.models == [FLASH]
    with pytest.raises(gen.NoRelevantSourcesError):
        run(gen.summarize_source(Pool([]), req))
