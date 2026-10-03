"""REAL BGE-M3 integration (no mocks). Skipped unless both are set:

    BGE_M3_URL            OpenAI-compatible embeddings base, e.g. http://127.0.0.1:55874/v1 (TEI serving BAAI/bge-m3)
    TEST_DATABASE_URL     disposable Postgres with pgvector + the CollabMind schema (1024-d)

Exercises: real vectors from the real model -> the exact INSERT used by rag/embedder.py -> pgvector ->
rag/retriever.py (vector + keyword SQL, thresholds) with workspace isolation."""

import asyncio
import math
import os
import uuid

import pytest

URL, DSN = os.environ.get("BGE_M3_URL"), os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not (URL and DSN), reason="BGE_M3_URL / TEST_DATABASE_URL not set")

import rag.retriever as retriever  # noqa: E402
from rag.embedding_provider import EmbeddingClient  # noqa: E402
from llm_helpers import embedding_settings, settings  # noqa: E402

DOCS = {
    "photosynthesis": "Photosynthesis is the process by which plants convert light energy into chemical energy. "
                      "Chlorophyll in the chloroplasts absorbs red and blue light and produces glucose and oxygen.",
    "mitochondria": "Mitochondria are the organelles that generate most of the cell's ATP through cellular respiration.",
    "tax": "The corporate tax filing deadline for the fiscal year is the fifteenth day of the fourth month; "
           "late submissions incur a penalty on the outstanding balance.",
    "spanish": "La fotosíntesis es el proceso mediante el cual las plantas convierten la luz solar en energía química.",
}


def client():
    return EmbeddingClient(embedding_settings(base_url=URL, api_key="", timeout_seconds=120))


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b))


def test_real_model_returns_1024_unit_vectors_and_sensible_similarities():
    c = client()
    vecs = asyncio.run(c.embed_documents(list(DOCS.values())))
    q = asyncio.run(c.embed_query("How do plants turn sunlight into energy?"))
    assert all(len(v) == 1024 for v in vecs) and len(q) == 1024
    assert all(math.isclose(math.sqrt(sum(x * x for x in v)), 1.0, abs_tol=1e-3) for v in vecs + [q])
    sims = {k: cosine(q, v) for k, v in zip(DOCS, vecs)}
    print("query similarities:", {k: round(s, 3) for k, s in sims.items()})
    assert sims["photosynthesis"] > sims["mitochondria"] > sims["tax"] or sims["photosynthesis"] > sims["tax"]
    assert sims["photosynthesis"] > sims["tax"] + 0.15           # relevant vs irrelevant gap
    assert sims["spanish"] > sims["tax"]                           # multilingual: ES passage ranks above tax text
    assert min(sims["photosynthesis"], sims["spanish"]) > retriever_floor()


def retriever_floor():
    return settings().retrieval.min_similarity


def test_index_and_retrieve_end_to_end_with_workspace_isolation(monkeypatch):
    import asyncpg
    monkeypatch.setattr(retriever, "get_settings", lambda: settings())
    monkeypatch.setattr(retriever, "assert_vector_schema", lambda: None)
    monkeypatch.setattr(retriever, "get_embedding_client", client)

    async def go():
        pool = await asyncpg.create_pool(DSN, min_size=1, max_size=2)
        ids = {k: str(uuid.uuid4()) for k in ("u", "wsA", "wsB", "sA", "sB")}
        c = client()
        try:
            async with pool.acquire() as conn:
                await conn.execute("INSERT INTO users(id,name,email) VALUES ($1,'t',$2)", ids["u"], ids["u"] + "@t.io")
                for w in ("wsA", "wsB"):
                    await conn.execute("INSERT INTO workspaces(id,name,created_by) VALUES ($1,$2,$3)", ids[w], w, ids["u"])
                await conn.execute("INSERT INTO sources(id,workspace_id,name,type,status) VALUES ($1,$2,'bio.pdf','file','ready')", ids["sA"], ids["wsA"])
                await conn.execute("INSERT INTO sources(id,workspace_id,name,type,status) VALUES ($1,$2,'private.pdf','file','ready')", ids["sB"], ids["wsB"])
                plan = [("wsA", "sA", 0, "photosynthesis", 2), ("wsA", "sA", 1, "mitochondria", 3), ("wsA", "sA", 2, "tax", 4),
                        ("wsB", "sB", 0, "photosynthesis", 1)]
                vectors = await c.embed_documents([DOCS[p[3]] for p in plan])
                for (ws, s, idx, key, page), v in zip(plan, vectors):
                    await conn.execute(  # same statement as rag/embedder.py
                        """INSERT INTO source_chunks (workspace_id, source_id, chunk_index, content, page_number,
                           location_label, embedding, embedding_model, embedding_dim)
                           VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9)""",
                        ids[ws], ids[s], idx, DOCS[key] + (" PRIVATE-B" if ws == "wsB" else ""), page, f"Page {page}",
                        "[" + ",".join(repr(x) for x in v) + "]", c.model, c.dimensions)

            relevant = await retriever.retrieve_chunks(pool, ids["wsA"], "How do plants convert sunlight into chemical energy?")
            irrelevant = await retriever.retrieve_chunks(pool, ids["wsA"], "What is the airspeed velocity of an unladen swallow?")
            other_ws = await retriever.retrieve_chunks(pool, ids["wsB"], "How do plants convert sunlight into chemical energy?")
            print("relevant:", [(r["chunk_index"], round(r["similarity"], 3), r["matched_by"]) for r in relevant])
            print("irrelevant:", [(r["chunk_index"], round(r["similarity"], 3)) for r in irrelevant])

            assert relevant and relevant[0]["chunk_index"] == 0 and (relevant[0]["page_number"], relevant[0]["location_label"]) == (2, "Page 2")
            assert all("PRIVATE-B" not in r["content"] for r in relevant)
            assert all(r["chunk_index"] != 2 for r in relevant)       # tax text never reaches the model for this query
            assert irrelevant == []                                    # nothing clears the similarity floor
            assert [r["source_name"] for r in other_ws] == ["private.pdf"]
        finally:
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [ids["wsA"], ids["wsB"]])
                await conn.execute("DELETE FROM users WHERE id=$1", ids["u"])
            await pool.close()

    asyncio.run(go())
