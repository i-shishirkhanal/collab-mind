"""BGE-M3 embedding client: shape/normalisation checks, batching, failure modes.
Mocked at the HTTP layer; no real BGE-M3 server is contacted here."""

import asyncio
import math

import httpx
import pytest

from llm import errors
from rag.embedding_provider import EmbeddingClient
from llm_helpers import embedding_settings


def run(coro):
    return asyncio.run(coro)


def unit(dim, hot=0):
    v = [0.0] * dim
    v[hot % dim] = 1.0
    return v


def make(handler, **kw):
    sleeps = []

    async def sleep(d):
        sleeps.append(d)

    c = EmbeddingClient(embedding_settings(**kw), transport=httpx.MockTransport(handler), sleep=sleep)
    c.sleeps = sleeps
    return c


def server(dim=1024, scale=1.0, record=None):
    def handler(request):
        import json
        body = json.loads(request.content)
        if record is not None:
            record.append((str(request.url), request.headers.get("authorization"), body))
        data = [{"index": i, "embedding": [x * scale for x in unit(dim, i)]} for i, _ in enumerate(body["input"])]
        return httpx.Response(200, json={"data": data[::-1], "model": body["model"]})  # shuffled on purpose
    return handler


def test_documents_and_queries_use_the_same_model_and_endpoint():
    seen = []
    c = make(server(record=seen))
    run(c.embed_documents(["a doc"]))
    run(c.embed_query("a query"))
    assert [s[0] for s in seen] == ["https://emb.test/v1/embeddings"] * 2
    assert {s[2]["model"] for s in seen} == {"BAAI/bge-m3"}
    assert seen[0][1] == "Bearer emb-secret-token-123456"
    assert "instruction" not in seen[0][2] and "prompt" not in seen[0][2]  # BGE-M3 takes no prefix


def test_returns_1024_dim_vectors_in_input_order():
    vecs = run(make(server()).embed(["a", "b", "c"]))
    assert [len(v) for v in vecs] == [1024] * 3
    assert [v.index(1.0) for v in vecs] == [0, 1, 2]  # re-ordered by `index`


def test_non_unit_vectors_are_l2_normalised():
    vecs = run(make(server(scale=5.0)).embed(["a"]))
    assert math.isclose(math.sqrt(sum(x * x for x in vecs[0])), 1.0, rel_tol=1e-6)


def test_batches_by_configured_size():
    seen = []
    vecs = run(make(server(record=seen), batch_size=2).embed([f"t{i}" for i in range(5)]))
    assert [len(s[2]["input"]) for s in seen] == [2, 2, 1] and len(vecs) == 5


def test_dimension_mismatch_is_rejected_not_stored():
    with pytest.raises(errors.EmbeddingUnavailableError, match="dimension mismatch"):
        run(make(server(dim=768)).embed(["a"]))


def test_wrong_vector_count_is_rejected():
    def handler(request):
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": unit(1024)}]})
    with pytest.raises(errors.EmbeddingUnavailableError, match="1 vectors for 2"):
        run(make(handler).embed(["a", "b"]))


@pytest.mark.parametrize("response", [
    httpx.Response(200, text="not json"),
    httpx.Response(200, json={"nope": 1}),
    httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.0] * 1024}]}),  # all-zero
])
def test_unreadable_or_degenerate_responses_are_rejected(response):
    with pytest.raises(errors.EmbeddingUnavailableError):
        run(make(lambda r: response).embed(["a"]))


def test_unconfigured_server_fails_clearly_and_makes_no_request():
    calls = []
    c = make(lambda r: calls.append(r), base_url="")
    with pytest.raises(errors.EmbeddingUnavailableError, match="EMBEDDING_BASE_URL"):
        run(c.embed(["a"]))
    assert calls == []


def test_transient_failures_retry_then_succeed():
    attempts = []

    def handler(request):
        attempts.append(1)
        if len(attempts) < 3:
            return httpx.Response(503, json={})
        return server()(request)

    c = make(handler)
    assert len(run(c.embed(["a"]))) == 1 and len(attempts) == 3


def test_persistent_failure_raises_and_is_bounded():
    attempts = []

    def handler(request):
        attempts.append(1)
        return httpx.Response(429, json={})

    with pytest.raises(errors.EmbeddingUnavailableError, match="rate limit"):
        run(make(handler, max_retries=2).embed(["a"]))
    assert len(attempts) == 3


@pytest.mark.parametrize("status", [401, 404])
def test_auth_and_missing_model_are_not_retried(status):
    attempts = []

    def handler(request):
        attempts.append(1)
        return httpx.Response(status, json={})

    with pytest.raises(errors.EmbeddingUnavailableError):
        run(make(handler).embed(["a"]))
    assert len(attempts) == 1


def test_timeout_and_connection_errors_become_embedding_unavailable():
    for exc in (httpx.ReadTimeout("t"), httpx.ConnectError("c")):
        def handler(request, exc=exc):
            raise exc
        with pytest.raises(errors.EmbeddingUnavailableError):
            run(make(handler, max_retries=0).embed(["a"]))


def test_empty_text_is_refused_instead_of_embedded():
    with pytest.raises(errors.EmbeddingUnavailableError, match="empty"):
        run(make(server()).embed(["   "]))


def test_no_fake_vector_path_exists():
    import rag.embedder as embedder
    import rag.retriever as retriever
    import inspect
    for mod in (embedder, retriever):
        src = inspect.getsource(mod)
        assert "hashlib" not in src and "sha256" not in src and "ALLOW_DEV_EMBEDDINGS" not in src
