"""The generic ReAct engine: step log, step limit, approval checkpoint, citations, tool scoping.
The model is a scripted fake at the HTTP boundary; the database is a recording fake pool."""

import asyncio
import json

import httpx
import pytest

pytest.importorskip("fastapi")
import uuid_shim  # noqa: F401

import llm
from agents import engine, tools
from agents.engine import AgentSpec, RunContext, parse_action
from agents.registry import AGENTS
from llm.types import Task
from llm_helpers import Recorder, chunk, completion_json, make_router


def reply(**action) -> httpx.Response:
    return httpx.Response(200, json=completion_json(text=json.dumps(action)))


class FakeConn:
    def __init__(self, log):
        self.log = log

    async def execute(self, sql, *args):
        self.log.append((sql, args))

    async def fetch(self, sql, *args):
        return []


class FakePool:
    def __init__(self):
        self.log = []

    def acquire(self):
        conn = FakeConn(self.log)

        class Ctx:
            async def __aenter__(self_):
                return conn

            async def __aexit__(self_, *exc):
                return False

        return Ctx()

    def steps(self):
        return [(a[2], a[4]) for sql, a in self.log if sql.startswith("INSERT INTO agent_steps")]

    def statuses(self):
        return [a[1] for sql, a in self.log if sql.startswith("UPDATE agent_runs SET status")]

    def last_result(self):
        results = [json.loads(a[2]) for sql, a in self.log
                   if sql.startswith("UPDATE agent_runs SET status") and len(a) > 2]
        return results[-1]


@pytest.fixture(autouse=True)
def stubs(monkeypatch):
    async def noop(*a, **k):
        return None

    monkeypatch.setattr(engine, "publish_status", noop)
    monkeypatch.setattr(engine, "record_usage", noop)
    yield
    llm.set_router(None)


def spec(**kw):
    base = dict(key="t", title="Test Agent", description="d", instructions="Do it.",
                tools=(tools.SEARCH,), max_steps=4, task=Task.STUDY)
    base.update(kw)
    return AgentSpec(**base)


def run(spec_, rec, goal="why is the sky blue"):
    llm.set_router(make_router(rec))
    pool = FakePool()
    ctx = RunContext(pool=pool, workspace_id="ws-1", user_id="u1", run_id="r1")
    asyncio.run(engine.run_agent(spec_, ctx, goal))
    return pool, ctx


def test_parse_action_tolerates_fences_and_prose():
    assert parse_action('{"action": "final", "answer": "x"}')["answer"] == "x"
    assert parse_action('Sure!\n```json\n{"action": "search_sources"}\n```')["action"] == "search_sources"
    assert parse_action("not json") is None
    assert parse_action('{"thought": "no action"}') is None


def test_search_then_final_with_citations_and_full_step_log(monkeypatch):
    seen = []

    async def fake_retrieve(pool, ws, q, top_k=None, **k):
        seen.append(ws)
        return [chunk(text="Rayleigh scattering favours blue light.")]

    monkeypatch.setattr(tools, "retrieve_chunks", fake_retrieve)
    rec = Recorder(
        reply(thought="search first", action="search_sources", input={"query": "sky blue"}),
        reply(thought="done", action="final", answer="Blue light scatters most [1]. Also [7]."),
    )
    pool, ctx = run(spec(), rec)

    assert seen == ["ws-1"]                       # scoped to the run's workspace
    kinds = [k for k, _ in pool.steps()]
    assert kinds == ["thought", "tool_call", "observation", "thought", "final"]
    assert pool.statuses()[0] == "running" and pool.statuses()[-1] == "completed"
    result = pool.last_result()
    assert "[1]" in result["answer"] and "[7]" not in result["answer"]   # unknown marker stripped
    assert result["citations"][0]["source_name"] == "biology.pdf" and result["warnings"]


def test_step_limit_forces_a_final_answer(monkeypatch):
    async def fake_retrieve(*a, **k):
        return [chunk()]

    monkeypatch.setattr(tools, "retrieve_chunks", fake_retrieve)
    search = reply(thought="more", action="search_sources", input={"query": "x"})
    final = reply(thought="wrap up", action="final", answer="Partial answer [1].")
    rec = Recorder(search, search, final)          # max_steps=2: two searches, then the forced turn
    pool, _ = run(spec(max_steps=2), rec)

    assert len(rec.requests) == 3
    assert any("Step limit (2) reached" in c for _, c in pool.steps())
    assert pool.statuses()[-1] == "completed" and pool.last_result()["answer"] == "Partial answer [1]."


def test_step_limit_without_an_answer_fails_cleanly(monkeypatch):
    async def fake_retrieve(*a, **k):
        return []

    monkeypatch.setattr(tools, "retrieve_chunks", fake_retrieve)
    loop = reply(thought="again", action="search_sources", input={"query": "x"})
    pool, _ = run(spec(max_steps=2), Recorder(loop))
    assert pool.statuses()[-1] == "failed" and "step limit" in pool.last_result()["message"]


def test_final_before_approval_is_sent_back_then_approved_run_completes(monkeypatch):
    async def approved(run_id):
        return "approved"

    monkeypatch.setattr(engine, "wait_for_decision", approved)
    rec = Recorder(
        reply(thought="skip", action="final", answer="too early"),
        reply(thought="plan", action="request_approval", input={"summary": "Outline: A, B"}),
        reply(thought="write", action="final", answer="The report."),
    )
    pool, ctx = run(spec(require_approval=True, tools=()), rec)

    assert ctx.approved
    assert pool.statuses() == ["running", "awaiting_approval", "running", "completed"]
    assert pool.last_result()["answer"] == "The report."
    assert "Tried to finish before approval" in " ".join(c for _, c in pool.steps())


def test_rejection_stops_the_run(monkeypatch):
    async def rejected(run_id):
        return "rejected"

    monkeypatch.setattr(engine, "wait_for_decision", rejected)
    rec = Recorder(reply(thought="plan", action="request_approval", input={"summary": "Outline"}))
    pool, _ = run(spec(require_approval=True, tools=()), rec)
    assert pool.statuses()[-1] == "rejected" and len(rec.requests) == 1


def test_approval_timeout_fails_the_run(monkeypatch):
    async def timeout(run_id):
        raise engine.AgentStopped("Agent stopped: approval was not given in time.")

    monkeypatch.setattr(engine, "wait_for_decision", timeout)
    rec = Recorder(reply(thought="plan", action="request_approval", input={"summary": "Outline"}))
    pool, _ = run(spec(require_approval=True, tools=()), rec)
    assert pool.statuses()[-1] == "failed" and "approval" in pool.last_result()["message"]


def test_model_cannot_choose_the_workspace(monkeypatch):
    seen = []

    async def fake_retrieve(pool, ws, q, **k):
        seen.append(ws)
        return []

    monkeypatch.setattr(tools, "retrieve_chunks", fake_retrieve)
    rec = Recorder(
        reply(thought="try", action="search_sources", input={"query": "x", "workspace_id": "evil-ws"}),
        reply(thought="done", action="final", answer="Nothing found."),
    )
    pool, _ = run(spec(), rec)
    assert seen == []                                    # the injected argument was rejected, not honoured
    assert "Bad input" in " ".join(c for _, c in pool.steps())


def test_bad_json_and_unknown_tools_do_not_crash_the_run():
    rec = Recorder(
        httpx.Response(200, json=completion_json(text="I will just talk")),
        reply(thought="x", action="delete_everything", input={}),
        reply(thought="ok", action="final", answer="Done."),
    )
    pool, _ = run(spec(), rec)
    assert pool.statuses()[-1] == "completed"
    log = " ".join(c for _, c in pool.steps())
    assert "not valid JSON" in log and "Unknown tool" in log


def test_provider_failure_is_reported_without_internals():
    rec = Recorder(httpx.Response(401, json={"error": {"message": "bad key sk-secret"}}))
    pool, _ = run(spec(), rec)
    assert pool.statuses()[-1] == "failed"
    assert "sk-secret" not in json.dumps(pool.last_result())


def test_registry_has_four_agents_and_approval_where_planned():
    assert set(AGENTS) == {"research", "literature_review", "debate", "report_builder"}
    assert AGENTS["report_builder"].require_approval and AGENTS["literature_review"].require_approval
    assert not AGENTS["research"].require_approval and not AGENTS["debate"].require_approval
    assert all(a.max_steps <= 10 for a in AGENTS.values())
