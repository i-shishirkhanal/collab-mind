"""
db.py — asyncpg connection pool management.

asyncpg is a fast, async-native PostgreSQL driver for Python.
A "connection pool" keeps several database connections open so each
request doesn't pay the cost of opening a new TCP connection.
"""

import os
import asyncpg  # async PostgreSQL driver


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


async def close_pool() -> None:
    """
    Gracefully close all connections in the pool.
    Called during app shutdown so Postgres doesn't see abrupt disconnects.
    """
    global _pool

    if _pool is not None:
        await _pool.close()  # Waits for in-flight queries to finish, then disconnects
        _pool = None          # Reset so get_pool() can re-create if needed
