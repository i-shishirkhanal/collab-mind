"""
agents/tools.py — the tools the specialist agents can call.

Every tool is bound to the run's workspace through `ctx`; none of them takes a workspace id from the
model. Passages are numbered through `ctx.passage_number` so the [n] markers in an agent's answer
resolve to real chunks the same way chat citations do.
"""

from __future__ import annotations

from agents.engine import RunContext, Tool
from rag.grounding import fence
from rag.retriever import retrieve_chunks

MAX_RESULTS = 8
READ_SOURCE_CHUNKS = 14


def _format(ctx: RunContext, chunks: list[dict]) -> str:
    parts = []
    for c in chunks:
        n = ctx.passage_number(c)
        where = f", {c['location_label']}" if c.get("location_label") else ""
        parts.append(f"[{n}] {c['source_name']}{where}\n{fence('PASSAGE', c['content'])}")
    return "\n\n".join(parts)


async def search_sources(ctx: RunContext, query: str = "", top_k: int = 5) -> str:
    query = str(query).strip()
    if not query:
        return "Give a non-empty query."
    top_k = max(1, min(int(top_k), MAX_RESULTS))
    chunks = await retrieve_chunks(ctx.pool, ctx.workspace_id, query, top_k=top_k)
    if not chunks:
        return "No passages in the workspace sources matched that query."
    return _format(ctx, chunks)


async def list_sources(ctx: RunContext) -> str:
    async with ctx.pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT s.name, s.type, COUNT(sc.*) AS chunks FROM sources s "
            "LEFT JOIN source_chunks sc ON sc.source_id = s.id "
            "WHERE s.workspace_id = $1 AND s.status = 'ready' AND s.is_active "
            "GROUP BY s.id, s.name, s.type ORDER BY s.name LIMIT 60",
            ctx.workspace_id,
        )
    if not rows:
        return "The workspace has no active, indexed sources."
    return "\n".join(f"- {r['name']} ({r['type']}, {r['chunks']} passages)" for r in rows)


async def read_source(ctx: RunContext, source_name: str = "") -> str:
    async with ctx.pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT sc.source_id::text AS source_id, sc.chunk_index, sc.content, sc.page_number, "
            "       sc.location_label, s.name AS source_name, s.type AS source_type "
            "FROM source_chunks sc JOIN sources s ON s.id = sc.source_id AND s.workspace_id = sc.workspace_id "
            "WHERE sc.workspace_id = $1 AND s.status = 'ready' AND s.is_active AND s.name = $2 "
            "ORDER BY sc.chunk_index LIMIT $3",
            ctx.workspace_id, str(source_name), READ_SOURCE_CHUNKS,
        )
    if not rows:
        return f"No active source named '{source_name}'. Use list_sources for exact names."
    chunks = [{**dict(r), "similarity": None} for r in rows]
    return _format(ctx, chunks)


SEARCH = Tool("search_sources",
              'input {"query": "<what to look for>", "top_k": 1-8}. Searches the workspace sources and returns '
              "numbered passages.", search_sources)
LIST = Tool("list_sources", "input {}. Lists the workspace's active sources with passage counts.", list_sources)
READ = Tool("read_source",
            'input {"source_name": "<exact name from list_sources>"}. Returns the opening passages of one source.',
            read_source)
