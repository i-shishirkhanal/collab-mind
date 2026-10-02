"""HTTP contract of the AI service: status codes for provider failures, the
chat response shape, and the SSE stream. Lifespan (Redis/Postgres) is not
started; the pool and pipeline are stubbed."""

import json

import httpx
import pytest

pytest.importorskip("fastapi.testclient")

TOKEN = "t" * 40
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)
    import main
    from fastapi.testclient import TestClient

    async def pool():
        return object()

    monkeypatch.setattr(main, "get_pool", pool)
    return main, TestClient(main.app, raise_server_exceptions=False)


def _result(**kw):
    from llm.types import Route, Task, Tier, Usage
    from rag.pipeline import RagResult
    from schemas import Citation
    base = dict(
        answer="Chlorophyll absorbs red light [1].",
        citations=[Citation(index=1, source_id="s1", source_name="biology.pdf", page_number=3,
                            chunk_index=0, excerpt="Chlorophyll…", location_label="Page 3", similarity=0.8)],
        grounding="grounded", warnings=[], task=Task.CHAT,
        route=Route("deepseek", Tier.FLASH, "deepseek-flash", "deepseek-flash", latency_ms=12),
        usage=Usage(10, 5, 15),
    )
    base.update(kw)
    return RagResult(**base)


def test_chat_response_contract(client, monkeypatch):
    main, c = client
    seen = {}

    async def fake(pool, **kw):
        seen.update(kw)
        return _result()

    monkeypatch.setattr(main, "run_rag_pipeline", fake)
    r = c.post("/chat", headers=AUTH, json={
        "workspace_id": "ws-A", "message": "q", "user_id": "u1", "source_ids": ["s1"], "task": "research",
        "conversation_history": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200
    body = r.json()
    assert body["answer"].startswith("Chlorophyll") and body["grounding"] == "grounded"
    assert body["citations"][0] == {"index": 1, "source_id": "s1", "source_name": "biology.pdf", "page_number": 3,
                                    "chunk_index": 0, "excerpt": "Chlorophyll…", "location_label": "Page 3",
                                    "similarity": 0.8}
    assert body["route"]["model_used"] == "deepseek-flash" and body["route"]["fallback_used"] is False
    assert body["usage"]["total_tokens"] == 15
    assert seen["workspace_id"] == "ws-A" and seen["source_ids"] == ["s1"] and seen["task"].value == "research"


def test_old_clients_still_work_with_minimal_request(client, monkeypatch):
    main, c = client

    async def fake(pool, **kw):
        return _result(route=None, usage=None, grounding="no_sources", citations=[])

    monkeypatch.setattr(main, "run_rag_pipeline", fake)
    r = c.post("/chat", headers=AUTH, json={"workspace_id": "ws", "message": "q"})
    assert r.status_code == 200 and r.json()["route"] is None


@pytest.mark.parametrize("exc_name,status,code", [
    ("NotConfiguredError", 503, "not_configured"),
    ("RateLimitedError", 429, "provider_rate_limited"),
    ("ProviderTimeoutError", 504, "provider_timeout"),
    ("EmbeddingUnavailableError", 503, "embedding_unavailable"),
    ("MalformedResponseError", 502, "malformed_response"),
    ("AuthenticationError", 502, "provider_auth_failed"),
])
def test_provider_failures_map_to_status_and_safe_message(client, monkeypatch, exc_name, status, code):
    main, c = client
    from llm import errors

    async def fake(pool, **kw):
        raise getattr(errors, exc_name)("secret sk-live-should-not-matter? no: safe text", provider="deepseek")

    monkeypatch.setattr(main, "run_rag_pipeline", fake)
    r = c.post("/chat", headers=AUTH, json={"workspace_id": "ws", "message": "q"})
    assert r.status_code == status and r.json()["code"] == code


def test_rate_limit_exposes_retry_after(client, monkeypatch):
    main, c = client
    from llm import errors

    async def fake(pool, **kw):
        e = errors.RateLimitedError("slow", provider="deepseek")
        e.retry_after = 7
        raise e

    monkeypatch.setattr(main, "run_rag_pipeline", fake)
    r = c.post("/chat", headers=AUTH, json={"workspace_id": "ws", "message": "q"})
    assert r.status_code == 429 and r.headers["retry-after"] == "7"


def test_unexpected_errors_do_not_leak_details(client, monkeypatch):
    main, c = client

    async def fake(pool, **kw):
        raise RuntimeError("password=hunter2 host=db.internal")

    monkeypatch.setattr(main, "run_rag_pipeline", fake)
    r = c.post("/chat", headers=AUTH, json={"workspace_id": "ws", "message": "q"})
    assert r.status_code == 500 and "hunter2" not in r.text


def test_auth_is_still_required(client):
    _, c = client
    assert c.post("/chat", json={"workspace_id": "ws", "message": "q"}).status_code == 401
    assert c.get("/health").status_code == 200


def test_models_endpoint_reports_routing_without_secrets(client, monkeypatch):
    main, c = client
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-should-never-appear-123456")
    import config
    config.reset_settings_cache()
    r = c.get("/models", headers=AUTH)
    config.reset_settings_cache()
    assert r.status_code == 200
    j = r.json()
    assert j["chat_and_study"]["model"] == "deepseek-flash" and j["research"]["model"] == "deepseek-v4-pro"
    assert j["embedding"]["model"] == "BAAI/bge-m3" and "sk-should-never" not in r.text


def test_stream_emits_deltas_then_result(client, monkeypatch):
    main, c = client

    async def fake(pool, **kw):
        yield "delta", "Chlorophyll "
        yield "delta", "absorbs [1]."
        yield "result", _result()

    monkeypatch.setattr(main, "stream_rag_pipeline", fake)
    r = c.post("/chat/stream", headers=AUTH, json={"workspace_id": "ws", "message": "q"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = [(b.split("\n")[0][7:], json.loads(b.split("\n")[1][6:])) for b in r.text.strip().split("\n\n")]
    assert [e for e, _ in events] == ["delta", "delta", "result"]
    assert events[2][1]["citations"][0]["source_name"] == "biology.pdf"


def test_stream_failure_before_first_byte_is_a_normal_http_error(client, monkeypatch):
    main, c = client
    from llm import errors

    async def fake(pool, **kw):
        raise errors.EmbeddingUnavailableError("down")
        yield  # pragma: no cover

    monkeypatch.setattr(main, "stream_rag_pipeline", fake)
    r = c.post("/chat/stream", headers=AUTH, json={"workspace_id": "ws", "message": "q"})
    assert r.status_code == 503


def test_stream_failure_mid_answer_becomes_an_error_event(client, monkeypatch):
    main, c = client
    from llm import errors

    async def fake(pool, **kw):
        yield "delta", "partial"
        raise errors.ProviderTimeoutError("timed out", provider="deepseek")

    monkeypatch.setattr(main, "stream_rag_pipeline", fake)
    r = c.post("/chat/stream", headers=AUTH, json={"workspace_id": "ws", "message": "q"})
    assert "event: delta" in r.text and "event: error" in r.text and "provider_timeout" in r.text
