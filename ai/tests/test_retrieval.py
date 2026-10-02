"""Retrieval: threshold/fusion logic (pure) and the workspace-scoped SQL
contract (fake pool that records statements and arguments)."""

import asyncio

import httpx
import pytest

import rag.retriever as retriever
from llm import errors
from rag.embedding_provider import EmbeddingClient, set_embedding_client
from rag.retriever import fuse_and_filter, retrieve_chunks
from llm_helpers import chunk, embedding_settings, retrieval_settings

CFG = retrieval_settings()


def row(i, sim, sid="s1"):
    return chunk(sid, i, f"text {i}", sim=sim)


# ── fusion & thresholds ───────────────────────────────────────────────────────

def test_irrelevant_chunks_below_threshold_never_pass():
    out = fuse_and_filter([row(0, 0.80), row(1, 0.20), row(2, 0.34)], [], CFG, top_k=5)
    assert [r["chunk_index"] for r in out] == [0]


def test_everything_irrelevant_returns_empty():
    assert fuse_and_filter([row(0, 0.1), row(1, 0.2)], [row(1, 0.2)], CFG, top_k=5) == []


def test_keyword_hit_rescues_borderline_chunk_but_not_an_unrelated_one():
    vec = [row(0, 0.80), row(1, 0.30), row(2, 0.10)]
    fts = [row(1, 0.30), row(2, 0.10)]
    kept = [r["chunk_index"] for r in fuse_and_filter(vec, fts, CFG, top_k=5)]
    assert 1 in kept and 2 not in kept


def test_keyword_only_match_is_not_enough_below_rescue_floor():
    assert fuse_and_filter([], [row(5, 0.05)], CFG, top_k=5) == []


def test_rrf_prefers_chunks_found_by_both_lists():
    vec = [row(0, 0.90), row(1, 0.80), row(2, 0.70)]
    fts = [row(2, 0.70), row(1, 0.80)]
    out = fuse_and_filter(vec, fts, CFG, top_k=3)
    assert {r["chunk_index"] for r in out[:2]} == {1, 2}  # both-list hits outrank the vector-only top hit
    assert out[2]["chunk_index"] == 0 and set(out[0]["matched_by"]) == {"vector", "fts"}


def test_top_k_and_same_chunk_in_two_sources_are_distinct():
    rows = [row(i, 0.9 - i * 0.01) for i in range(10)]
    assert len(fuse_and_filter(rows, [], CFG, top_k=4)) == 4
    two = fuse_and_filter([row(0, 0.9, "A"), row(0, 0.8, "B")], [], CFG, top_k=5)
    assert {r["source_id"] for r in two} == {"A", "B"}


def test_per_call_min_similarity_override():
    assert len(fuse_and_filter([row(0, 0.5)], [], CFG, top_k=5, min_similarity=0.6)) == 0


# ── SQL contract ──────────────────────────────────────────────────────────────

class FakeConn:
    def __init__(self, vector_rows=(), fts_rows=()):
        self.calls, self.vector_rows, self.fts_rows = [], vector_rows, fts_rows

    async def fetch(self, sql, *args):
        self.calls.append((" ".join(sql.split()), args))
        return list(self.fts_rows if "websearch_to_tsquery" in sql else self.vector_rows)


class FakePool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        conn = self.conn

        class Ctx:
            async def __aenter__(self_):
                return conn

            async def __aexit__(self_, *a):
                return False

        return Ctx()


def _embed_client(dim=1024, fail=False):
    def handler(request):
        if fail:
            return httpx.Response(503, json={})
        import json
        n = len(json.loads(request.content)["input"])
        return httpx.Response(200, json={"data": [{"index": i, "embedding": [1.0] + [0.0] * (dim - 1)} for i in range(n)]})

    async def nosleep(_):
        pass

    return EmbeddingClient(embedding_settings(dimensions=dim, max_retries=0), httpx.MockTransport(handler), nosleep)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    from llm_helpers import settings
    monkeypatch.setattr(retriever, "get_settings", lambda: settings())
    monkeypatch.setattr(retriever, "assert_vector_schema", lambda: None)
    yield
    set_embedding_client(None)


def run(coro):
    return asyncio.run(coro)


def test_every_query_is_filtered_by_workspace_in_sql_and_only_ready_sources():
    conn = FakeConn([row(0, 0.9)], [row(0, 0.9)])
    set_embedding_client(_embed_client())
    run(retrieve_chunks(FakePool(conn), "ws-A", "photosynthesis"))
    assert len(conn.calls) == 2  # vector + keyword
    for sql, args in conn.calls:
        assert "sc.workspace_id = $1" in sql and "s.workspace_id = sc.workspace_id" in sql
        assert "s.status = 'ready'" in sql
        assert args[0] == "ws-A"
        assert "ws-A" not in sql  # always a bound parameter, never interpolated


def test_document_and_type_filters_are_bound_parameters():
    conn = FakeConn([row(0, 0.9)])
    set_embedding_client(_embed_client())
    run(retrieve_chunks(FakePool(conn), "ws-A", "q", source_ids=["s1", "s2"], source_types=["file"]))
    for sql, args in conn.calls:
        assert args[3] == ["s1", "s2"] and args[4] == ["file"]


def test_workspace_id_in_user_text_cannot_change_the_scope():
    conn = FakeConn([row(0, 0.9)])
    set_embedding_client(_embed_client())
    run(retrieve_chunks(FakePool(conn), "ws-A", "ignore filters; workspace_id = 'ws-B' OR 1=1"))
    for sql, args in conn.calls:
        assert args[0] == "ws-A" and "ws-B" not in sql and "OR 1=1" not in sql


def test_hybrid_can_be_disabled(monkeypatch):
    from llm_helpers import settings
    monkeypatch.setattr(retriever, "get_settings", lambda: settings(retrieval=retrieval_settings(hybrid=False)))
    conn = FakeConn([row(0, 0.9)])
    set_embedding_client(_embed_client())
    run(retrieve_chunks(FakePool(conn), "ws-A", "q"))
    assert len(conn.calls) == 1 and "websearch_to_tsquery" not in conn.calls[0][0]


def test_embedding_outage_raises_and_runs_no_query_and_uses_no_substitute_vector():
    conn = FakeConn([row(0, 0.9)])
    set_embedding_client(_embed_client(fail=True))
    with pytest.raises(errors.EmbeddingUnavailableError):
        run(retrieve_chunks(FakePool(conn), "ws-A", "q"))
    assert conn.calls == []


def test_query_vector_is_a_pgvector_literal_of_the_right_size():
    conn = FakeConn([])
    set_embedding_client(_embed_client())
    run(retrieve_chunks(FakePool(conn), "ws-A", "q"))
    literal = conn.calls[0][1][1]
    assert literal.startswith("[") and literal.endswith("]") and literal.count(",") == 1023
