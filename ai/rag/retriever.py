"""
rag/retriever.py — Workspace-scoped hybrid retrieval over pgvector + Postgres
full-text search.

Guarantees:
  * every query is filtered by `workspace_id` in SQL (never post-filtered), and
    only sources with status = 'ready' are searched;
  * the query vector comes from the same BGE-M3 client/config as the indexed
    chunks — if embeddings are unavailable this raises
    EmbeddingUnavailableError instead of searching with a substitute;
  * chunks below the similarity threshold never reach the model. A chunk found
    only by keyword search is kept only above a lower "rescue" floor, so a
    stray keyword match in an unrelated passage is still rejected.

Ranking is Reciprocal Rank Fusion of the vector list and the keyword list.
"""

from __future__ import annotations

from typing import Optional, Sequence

import asyncpg

from config import RetrievalSettings, get_settings
from rag.embedding_provider import get_embedding_client

_COLUMNS = """
    sc.source_id::text AS source_id, sc.chunk_index, sc.content, sc.page_number,
    sc.location_label, s.name AS source_name, s.type AS source_type,
    1 - (sc.embedding <=> $2::vector) AS similarity
"""

_SCOPE = """
    FROM source_chunks sc
    JOIN sources s ON s.id = sc.source_id AND s.workspace_id = sc.workspace_id
    {extra_from}
    WHERE sc.workspace_id = $1
      AND s.status = 'ready'
      AND ($4::uuid[] IS NULL OR sc.source_id = ANY($4::uuid[]))
      AND ($5::text[] IS NULL OR s.type = ANY($5::text[]))
"""

# 'simple' config: language-neutral, matches the generated `fts` column.
_FTS_FROM = ", websearch_to_tsquery('simple', $6::text) q"

VECTOR_SQL = f"SELECT {_COLUMNS} {_SCOPE.format(extra_from='')} ORDER BY sc.embedding <=> $2::vector LIMIT $3"

FTS_SQL = (
    f"SELECT {_COLUMNS} {_SCOPE.format(extra_from=_FTS_FROM)}"
    "  AND sc.fts @@ q ORDER BY ts_rank_cd(sc.fts, q) DESC LIMIT $3"
)


def _key(row: dict) -> tuple[str, int]:
    return (row["source_id"], row["chunk_index"])


def fuse_and_filter(
    vector_rows: Sequence[dict],
    fts_rows: Sequence[dict],
    cfg: RetrievalSettings,
    top_k: int,
    min_similarity: Optional[float] = None,
) -> list[dict]:
    """Pure function: RRF-merge two ranked lists, drop irrelevant chunks, cut to top_k."""
    floor = cfg.min_similarity if min_similarity is None else min_similarity
    rescue_floor = min(cfg.fts_rescue_min_similarity, floor)

    merged: dict[tuple[str, int], dict] = {}
    for source, rows in (("vector", vector_rows), ("fts", fts_rows)):
        for rank, row in enumerate(rows, start=1):
            entry = merged.setdefault(_key(row), {**row, "rrf": 0.0, "matched_by": []})
            entry["rrf"] += 1.0 / (cfg.rrf_k + rank)
            entry["matched_by"].append(source)

    kept = []
    for entry in merged.values():
        sim = float(entry["similarity"])
        if sim >= floor or ("fts" in entry["matched_by"] and sim >= rescue_floor):
            entry["similarity"] = sim
            kept.append(entry)

    kept.sort(key=lambda e: (e["rrf"], e["similarity"]), reverse=True)
    return kept[:top_k]


def _vec(v: Sequence[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in v) + "]"


async def retrieve_chunks(
    pool: asyncpg.Pool,
    workspace_id: str,
    query: str,
    top_k: Optional[int] = None,
    *,
    source_ids: Optional[Sequence[str]] = None,
    source_types: Optional[Sequence[str]] = None,
    min_similarity: Optional[float] = None,
) -> list[dict]:
    cfg = get_settings().retrieval
    top_k = top_k or cfg.top_k
    query_vector = await get_embedding_client().embed_query(query)  # raises if unavailable
    vec = _vec(query_vector)
    ids = list(source_ids) if source_ids else None
    types = list(source_types) if source_types else None
    pool_size = max(cfg.candidates, top_k)

    async with pool.acquire() as conn:
        vector_rows = [dict(r) for r in await conn.fetch(VECTOR_SQL, workspace_id, vec, pool_size, ids, types)]
        fts_rows: list[dict] = []
        if cfg.hybrid and query.strip():
            fts_rows = [dict(r) for r in await conn.fetch(
                FTS_SQL, workspace_id, vec, pool_size, ids, types, query)]

    return fuse_and_filter(vector_rows, fts_rows, cfg, top_k, min_similarity)


async def sample_chunks(
    pool: asyncpg.Pool,
    workspace_id: str,
    limit: int,
    source_ids: Optional[Sequence[str]] = None,
) -> list[dict]:
    """Broad coverage without a topic: an even spread of chunks per source, in
    reading order. No embeddings involved, so no similarity score is claimed."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM (
                SELECT sc.source_id::text AS source_id, sc.chunk_index, sc.content, sc.page_number,
                       sc.location_label, s.name AS source_name, s.type AS source_type,
                       ROW_NUMBER() OVER (PARTITION BY sc.source_id ORDER BY sc.chunk_index) AS rn,
                       COUNT(*)     OVER (PARTITION BY sc.source_id) AS total
                FROM source_chunks sc
                JOIN sources s ON s.id = sc.source_id AND s.workspace_id = sc.workspace_id
                WHERE sc.workspace_id = $1 AND s.status = 'ready'
                  AND ($3::uuid[] IS NULL OR sc.source_id = ANY($3::uuid[]))
            ) t
            ORDER BY (rn::float / total), source_id, chunk_index
            LIMIT $2
            """,
            workspace_id, limit, list(source_ids) if source_ids else None,
        )
    chunks = [{**dict(r), "similarity": None, "matched_by": ["sample"]} for r in rows]
    chunks.sort(key=lambda c: (c["source_id"], c["chunk_index"]))
    return chunks
