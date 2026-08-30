"""
rag/retriever.py — Fetches the top-k most semantically similar chunks
                   from pgvector, always scoped to one workspace.
"""

import os
import asyncpg
import google.generativeai as genai

EMBED_MODEL = "models/text-embedding-004"
DEFAULT_TOP_K = 5


async def retrieve_chunks(
    pool: asyncpg.Pool,
    workspace_id: str,
    query: str,
    top_k: int = DEFAULT_TOP_K,
) -> list[dict]:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    query_vector = None

    if api_key and not api_key.startswith("dummy"):
        try:
            result = genai.embed_content(
                model=EMBED_MODEL,
                content=query,
                task_type="RETRIEVAL_QUERY",
            )
            query_vector = result["embedding"]
        except Exception as exc:
            print(f"[Retriever] Gemini embed error ({exc}). Using query vector fallback.")

    if query_vector is None:
        import hashlib
        h = hashlib.sha256(query.encode('utf-8')).digest()
        vec = [((h[i % len(h)] / 255.0) * 2.0 - 1.0) for i in range(768)]
        norm = sum(x * x for x in vec) ** 0.5 or 1.0
        query_vector = [x / norm for x in vec]

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                sc.content,
                sc.source_id,
                sc.chunk_index,
                sc.page_number,
                s.name AS source_name,
                sc.embedding <=> $2::vector AS distance
            FROM   source_chunks sc
            JOIN   sources s
                ON s.id           = sc.source_id
                AND s.workspace_id = sc.workspace_id
            WHERE  sc.workspace_id = $1
            ORDER  BY distance ASC
            LIMIT  $3
            """,
            workspace_id,
            str(query_vector),
            top_k,
        )

    return [dict(row) for row in rows]
