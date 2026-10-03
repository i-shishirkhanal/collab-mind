"""Real-Postgres checks of the retrieval SQL (workspace isolation, status filter,
thresholds, hybrid search, schema guard). Skipped unless TEST_DATABASE_URL points
at a disposable database that already has the CollabMind schema + pgvector, e.g.

    docker run -d --rm -p 127.0.0.1:55873:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=cm ankane/pgvector
    # apply the supabase/migrations, then:
    TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55873/cm pytest tests/test_retrieval_db.py

The tests create and delete their own rows (random UUIDs) and never touch others."""

import asyncio
import os
import uuid

import pytest

asyncpg = pytest.importorskip("asyncpg")
DSN = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

import db  # noqa: E402
import rag.retriever as retriever  # noqa: E402
from llm import errors  # noqa: E402
from llm_helpers import settings  # noqa: E402

DIM = 1024


def vec(*pairs):
    """Sparse -> dense pgvector literal, e.g. vec((0, 1.0), (1, 0.5))."""
    v = [0.0] * DIM
    for i, x in pairs:
        v[i] = x
    n = sum(x * x for x in v) ** 0.5
    return "[" + ",".join(repr(x / n) for x in v) + "]"


class StubEmbedder:
    """Returns a chosen query vector; this test is about SQL, not the model."""

    def __init__(self, literal):
        self.literal = literal

    async def embed_query(self, text):
        return [float(x) for x in self.literal.strip("[]").split(",")]


def run(coro):
    return asyncio.run(coro)


async def _seed(conn):
    ids = {k: str(uuid.uuid4()) for k in ("wsA", "wsB", "uA", "srcA", "srcA2", "srcB", "srcPending")}
    await conn.execute("INSERT INTO users(id,name,email) VALUES ($1,'t',$2)", ids["uA"], f"{ids['uA']}@t.io")
    for w in ("wsA", "wsB"):
        await conn.execute("INSERT INTO workspaces(id,name,created_by) VALUES ($1,$2,$3)", ids[w], w, ids["uA"])
    for key, ws, name, status in [("srcA", "wsA", "bio.pdf", "ready"), ("srcA2", "wsA", "other.pdf", "ready"),
                                  ("srcB", "wsB", "secret.pdf", "ready"), ("srcPending", "wsA", "wip.pdf", "processing")]:
        await conn.execute("INSERT INTO sources(id,workspace_id,name,type,status) VALUES ($1,$2,$3,'file',$4)",
                           ids[key], ids[ws], name, status)
    rows = [  # (workspace, source, idx, text, page, label, vector)
        ("wsA", "srcA", 0, "Chlorophyll absorbs red light in leaves.", 3, "Page 3", vec((0, 1.0))),
        ("wsA", "srcA", 1, "Unrelated shipping logistics paragraph.", 4, "Page 4", vec((5, 1.0))),
        ("wsA", "srcA2", 0, "Quokka facts live here.", None, None, vec((7, 1.0))),   # keyword-only candidate
        ("wsB", "srcB", 0, "Chlorophyll absorbs red light — WORKSPACE B SECRET.", 1, "Page 1", vec((0, 1.0))),
        ("wsA", "srcPending", 0, "Chlorophyll draft not yet ready.", 1, "Page 1", vec((0, 1.0))),
    ]
    for ws, src, idx, text, page, label, v in rows:
        await conn.execute(
            "INSERT INTO source_chunks(workspace_id,source_id,chunk_index,content,page_number,location_label,embedding)"
            " VALUES ($1,$2,$3,$4,$5,$6,$7::vector)", ids[ws], ids[src], idx, text, page, label, v)
    return ids


async def _cleanup(conn, ids):
    await conn.execute("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [ids["wsA"], ids["wsB"]])
    await conn.execute("DELETE FROM users WHERE id = $1", ids["uA"])


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(retriever, "get_settings", lambda: settings())
    monkeypatch.setattr(retriever, "assert_vector_schema", lambda: None)
    yield
    retriever.set_embedding_client = None  # noqa — keep module clean


def _with_db(fn):
    async def go():
        pool = await asyncpg.create_pool(DSN, min_size=1, max_size=2)
        try:
            async with pool.acquire() as conn:
                ids = await _seed(conn)
            try:
                await fn(pool, ids)
            finally:
                async with pool.acquire() as conn:
                    await _cleanup(conn, ids)
        finally:
            await pool.close()
    asyncio.run(go())


def _use_query_vector(monkeypatch, literal):
    monkeypatch.setattr(retriever, "get_embedding_client", lambda: StubEmbedder(literal))


def test_only_the_callers_workspace_and_only_ready_sources_are_returned(env, monkeypatch):
    _use_query_vector(monkeypatch, vec((0, 1.0)))

    async def body(pool, ids):
        got = await retriever.retrieve_chunks(pool, ids["wsA"], "chlorophyll red light")
        texts = " ".join(c["content"] for c in got)
        assert "WORKSPACE B SECRET" not in texts and "draft not yet ready" not in texts
        assert [c["source_name"] for c in got][0] == "bio.pdf"
        top = got[0]
        assert (top["page_number"], top["location_label"], top["chunk_index"]) == (3, "Page 3", 0)
        assert top["source_id"] == ids["srcA"] and top["similarity"] > 0.99

        other = await retriever.retrieve_chunks(pool, ids["wsB"], "chlorophyll red light")
        assert [c["source_name"] for c in other] == ["secret.pdf"]

        none = await retriever.retrieve_chunks(pool, str(uuid.uuid4()), "chlorophyll red light")
        assert none == []

    _with_db(body)


def test_irrelevant_chunks_are_filtered_by_threshold(env, monkeypatch):
    _use_query_vector(monkeypatch, vec((0, 1.0)))

    async def body(pool, ids):
        got = await retriever.retrieve_chunks(pool, ids["wsA"], "zzz nothing matches")
        assert all("shipping" not in c["content"] for c in got)  # orthogonal vector, similarity ~0

    _with_db(body)


def test_query_unrelated_to_everything_returns_nothing(env, monkeypatch):
    _use_query_vector(monkeypatch, vec((100, 1.0)))

    async def body(pool, ids):
        assert await retriever.retrieve_chunks(pool, ids["wsA"], "zzz nothing matches") == []

    _with_db(body)


def test_document_level_constraint(env, monkeypatch):
    _use_query_vector(monkeypatch, vec((0, 1.0), (7, 0.9)))

    async def body(pool, ids):
        got = await retriever.retrieve_chunks(pool, ids["wsA"], "chlorophyll quokka", source_ids=[ids["srcA2"]])
        assert {c["source_name"] for c in got} <= {"other.pdf"}
        # a source id from ANOTHER workspace yields nothing for this workspace
        assert await retriever.retrieve_chunks(pool, ids["wsA"], "chlorophyll", source_ids=[ids["srcB"]]) == []

    _with_db(body)


def test_keyword_match_rescues_a_chunk_the_vector_alone_would_drop(env, monkeypatch):
    # query vector is moderately close to the quokka chunk (~0.30: below 0.35, above the 0.25 rescue floor)
    _use_query_vector(monkeypatch, vec((0, 1.0), (7, 0.33)))

    async def body(pool, ids):
        with_kw = await retriever.retrieve_chunks(pool, ids["wsA"], "quokka")
        assert any("Quokka" in c["content"] and "fts" in c["matched_by"] for c in with_kw)
        without_kw = await retriever.retrieve_chunks(pool, ids["wsA"], "marsupial")
        assert all("Quokka" not in c["content"] for c in without_kw)

    _with_db(body)


def test_malicious_query_text_is_data_not_sql(env, monkeypatch):
    _use_query_vector(monkeypatch, vec((0, 1.0)))

    async def body(pool, ids):
        got = await retriever.retrieve_chunks(pool, ids["wsA"], "'; DROP TABLE source_chunks; -- workspace_id")
        assert isinstance(got, list)
        async with pool.acquire() as conn:
            assert await conn.fetchval("SELECT count(*) FROM source_chunks WHERE workspace_id=$1", ids["wsA"]) == 4

    _with_db(body)


def test_schema_guard_detects_dimension_mismatch(monkeypatch):
    async def go():
        pool = await asyncpg.create_pool(DSN, min_size=1, max_size=1)
        try:
            await db.ensure_schema(pool)
            assert db.SCHEMA_PROBLEM is None, db.SCHEMA_PROBLEM
            db.assert_vector_schema()
            import config
            monkeypatch.setattr(db, "get_settings", lambda: settings(embedding=__import__("llm_helpers").embedding_settings(dimensions=768)))
            await db.ensure_schema(pool)
            assert db.SCHEMA_PROBLEM and "1024" in db.SCHEMA_PROBLEM
            with pytest.raises(errors.EmbeddingUnavailableError):
                db.assert_vector_schema()
        finally:
            db.SCHEMA_PROBLEM = None
            await pool.close()
    asyncio.run(go())


def test_sample_chunks_is_workspace_scoped_and_ready_only(env):
    async def body(pool, ids):
        got = await retriever.sample_chunks(pool, ids["wsA"], 10)
        names = {c["source_name"] for c in got}
        assert names == {"bio.pdf", "other.pdf"} and all(c["similarity"] is None for c in got)

    _with_db(body)


def test_usage_record_and_chunk_insert_match_the_real_schema(env):
    from llm.types import Route, Tier, Usage
    from rag.usage import record_usage

    async def body(pool, ids):
        route = Route("deepseek", Tier.PRO, "deepseek-v4-pro", "deepseek-v4-pro", attempts=2,
                      fallback_used=False, latency_ms=900)
        await record_usage(pool, workspace_id=ids["wsA"], user_id=ids["uA"], kind="chat", task="research",
                           route=route, usage=Usage(10, 5, 15, 3))
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM llm_usage WHERE workspace_id=$1", ids["wsA"])
            assert (row["model_used"], row["total_tokens"], row["attempts"], row["tier"]) == ("deepseek-v4-pro", 15, 2, "pro")
            # the exact INSERT used by rag/embedder.py
            await conn.execute(
                """INSERT INTO source_chunks (workspace_id, source_id, chunk_index, content, page_number,
                   location_label, embedding, embedding_model, embedding_dim)
                   VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9)""",
                ids["wsA"], ids["srcA"], 9, "x", 1, "Page 1", vec((1, 1.0)), "BAAI/bge-m3", 1024)
            with pytest.raises(asyncpg.exceptions.DataError):  # wrong dimension is rejected by pgvector
                await conn.execute("INSERT INTO source_chunks (workspace_id, source_id, chunk_index, content, embedding)"
                                   " VALUES ($1,$2,10,'y','[1,2,3]'::vector)", ids["wsA"], ids["srcA"])

    _with_db(body)
