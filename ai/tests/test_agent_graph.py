"""Study-coach LangGraph nodes use the router (Flash for study work) and never
substitute canned text when the model or sources are missing."""

import asyncio

import httpx
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("fastapi.testclient")
import uuid_shim  # noqa: F401  (loads even where the uuid_utils DLL is blocked)

import llm
import agents.study_coach_graph as graph
from llm import errors
from llm_helpers import FLASH, Recorder, chunk, completion_json, make_router


async def _noop(*a, **k):
    return None


@pytest.fixture(autouse=True)
def stubs(monkeypatch):
    monkeypatch.setattr(graph, "publish_status", _noop)
    monkeypatch.setattr(graph, "record_usage", _noop)
    yield
    llm.set_router(None)


def state(**kw):
    base = dict(workspace_id="ws", user_id="u", run_id="r", goal="learn photosynthesis", topics=["A", "B"],
                plan="PLAN", approved=False, materials=None, status="s", pool=None)
    base.update(kw)
    return base


def ok(text):
    return httpx.Response(200, json=completion_json(text=text))


def test_topics_come_from_flash_over_retrieved_chunks(monkeypatch):
    rec = Recorder(ok("Light reactions, Calvin cycle, Chlorophyll"))
    llm.set_router(make_router(rec))

    async def fake(pool, ws, q, top_k=None, **k):
        assert ws == "ws"
        return [chunk()]

    monkeypatch.setattr(graph, "retrieve_chunks", fake)
    out = asyncio.run(graph.analyze_sources(state()))
    assert out["topics"] == ["Light reactions", "Calvin cycle", "Chlorophyll"] and rec.models == [FLASH]


def test_no_relevant_sources_is_an_error_not_invented_topics(monkeypatch):
    llm.set_router(make_router(Recorder(ok("x"))))

    async def none(*a, **k):
        return []

    monkeypatch.setattr(graph, "retrieve_chunks", none)
    with pytest.raises(graph.NoRelevantSourcesError):
        asyncio.run(graph.analyze_sources(state()))


def test_plan_and_materials_use_the_model_and_fail_loudly_without_it():
    rec = Recorder(ok("Day 1: ..."))
    llm.set_router(make_router(rec))
    assert asyncio.run(graph.create_plan(state()))["plan"] == "Day 1: ..."
    assert asyncio.run(graph.generate_materials(state()))["materials"] == "Day 1: ..."

    llm.set_router(make_router(Recorder(ok("x")), api_key=""))
    with pytest.raises(errors.NotConfiguredError):
        asyncio.run(graph.create_plan(state()))
