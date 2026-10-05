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


# Objects the service needs. They are created by supabase/migrations/, the only owner of the
# schema; the service never runs DDL itself.
_REQUIRED_COLUMNS = {
    "source_chunks": ("location_label", "embedding_model", "embedding_dim", "fts"),
    "sources": ("is_active",),
    "agent_runs": ("finished_at", "goal", "step_count"),
    "agent_steps": ("run_id", "step_no"),
    "llm_usage": ("workspace_id", "total_tokens"),
}


async def ensure_schema(pool: asyncpg.Pool) -> None:
    """Verify (read-only) that the database matches what the service expects: the migrations have
    been applied and the pgvector column has the configured embedding dimension. A mismatch sets
    SCHEMA_PROBLEM, which makes indexing and retrieval fail loudly instead of corrupting data."""
    global SCHEMA_PROBLEM
    expected_dim = get_settings().embedding.dimensions
    async with pool.acquire() as conn:
        present = {
            (r["table_name"], r["column_name"])
            for r in await conn.fetch(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = ANY($1::text[])",
                list(_REQUIRED_COLUMNS),
            )
        }
        # pgvector stores the dimension in atttypmod.
        actual = await conn.fetchval(
            "SELECT atttypmod FROM pg_attribute "
            "WHERE attrelid = 'source_chunks'::regclass AND attname = 'embedding'"
        )
    missing = [f"{t}.{c}" for t, cols in _REQUIRED_COLUMNS.items() for c in cols if (t, c) not in present]
    if missing:
        SCHEMA_PROBLEM = (
            f"database schema is out of date (missing {', '.join(missing)}). "
            "Apply the migrations in supabase/migrations/."
        )
        print(f"[DB] SCHEMA PROBLEM: {SCHEMA_PROBLEM}")
    elif actual != expected_dim:
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
