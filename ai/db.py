"""
db.py — asyncpg connection pool management.

asyncpg is a fast, async-native PostgreSQL driver for Python.
A "connection pool" keeps several database connections open so each
request doesn't pay the cost of opening a new TCP connection.
"""

import os
import asyncpg  # async PostgreSQL driver

from config import get_settings

# Set by ensure_schema() when the vector column dimension disagrees with the
# configured embedding model; indexing/retrieval refuse to run while set.
SCHEMA_PROBLEM: str | None = None

# Module-level variable that holds the pool once it is created.
# It starts as None; get_pool() creates it on first call.
_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    """
    Return the shared connection pool, creating it on first call.
    This is called at startup and then reused for every request.
    """
    global _pool  # We need to assign to the module-level variable, so we declare it global

    if _pool is None:
        # asyncpg.create_pool() opens `min_size` connections immediately
        # and can grow up to `max_size` under load.
        _pool = await asyncpg.create_pool(
            dsn=os.environ["DATABASE_URL"],  # e.g. postgresql://user:pass@host/db
            min_size=2,                       # Always keep at least 2 connections open
            max_size=10,                      # Never open more than 10 at once
        )

    return _pool


async def ensure_schema(pool: asyncpg.Pool) -> None:
    """Idempotent column additions so databases created before a feature
    shipped (migration.sql only runs on first init) pick it up on startup."""
    global SCHEMA_PROBLEM
    expected_dim = get_settings().embedding.dimensions
    async with pool.acquire() as conn:
        await conn.execute(
            "ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS location_label TEXT"
        )
        # Phase 3 additions (same DDL as supabase/migrations/20261002020000_*).
        await conn.execute("ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT")
        await conn.execute("ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS embedding_dim INT")
        await conn.execute(
            "ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS fts tsvector "
            "GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS index_source_chunks_on_fts ON source_chunks USING gin (fts)"
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS llm_usage (
                id BIGSERIAL PRIMARY KEY,
                workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id) ON DELETE SET NULL,
                kind TEXT NOT NULL, task TEXT NOT NULL,
                provider TEXT NOT NULL, tier TEXT NOT NULL,
                model_requested TEXT NOT NULL, model_used TEXT NOT NULL,
                prompt_tokens INT, completion_tokens INT, total_tokens INT, reasoning_tokens INT,
                latency_ms INT, attempts INT NOT NULL DEFAULT 1,
                fallback_used BOOLEAN NOT NULL DEFAULT FALSE, fallback_reason TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS index_llm_usage_workspace ON llm_usage (workspace_id, created_at DESC)"
        )
        # pgvector stores the dimension in atttypmod. Never alter it silently:
        # a mismatch means the (destructive) migration has not been run.
        actual = await conn.fetchval(
            "SELECT atttypmod FROM pg_attribute "
            "WHERE attrelid = 'source_chunks'::regclass AND attname = 'embedding'"
        )
    if actual != expected_dim:
        SCHEMA_PROBLEM = (
            f"source_chunks.embedding is vector({actual}) but the embedding model is configured for "
            f"{expected_dim} dimensions. Apply supabase/migrations/20261002020000_phase3_embeddings_rag.sql "
            "and re-index sources."
        )
        print(f"[DB] SCHEMA PROBLEM: {SCHEMA_PROBLEM}")
    else:
        SCHEMA_PROBLEM = None


def assert_vector_schema() -> None:
    """Raise a clear, non-silent error when the pgvector column does not match
    the embedding model (used by indexing and retrieval)."""
    if SCHEMA_PROBLEM:
        from llm.errors import EmbeddingUnavailableError
        raise EmbeddingUnavailableError(SCHEMA_PROBLEM)


async def close_pool() -> None:
    """
    Gracefully close all connections in the pool.
    Called during app shutdown so Postgres doesn't see abrupt disconnects.
    """
    global _pool

    if _pool is not None:
        await _pool.close()  # Waits for in-flight queries to finish, then disconnects
        _pool = None          # Reset so get_pool() can re-create if needed
