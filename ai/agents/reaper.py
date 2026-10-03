"""
agents/reaper.py — fail agent runs that can no longer finish.

Study-coach runs are in-process background tasks. If the service restarts (deploy, crash, OOM)
the task is gone but its `agent_runs` row stays in a non-terminal state forever, and the UI
waits for it indefinitely. A run that is older than the longest legitimate run (approval wait
of 10 minutes plus generation) is marked `failed` and the workspace is told.
"""

import asyncio
import logging

import asyncpg

from redis_client import publish_status

log = logging.getLogger("collabmind.ai.reaper")

MAX_RUN_AGE_MINUTES = 30
SWEEP_INTERVAL_SECONDS = 300


async def reap_stuck_runs(pool: asyncpg.Pool, max_age_minutes: int = MAX_RUN_AGE_MINUTES) -> int:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            UPDATE agent_runs
               SET status = 'failed', finished_at = NOW()
             WHERE status NOT IN ('completed', 'failed')
               AND created_at < NOW() - make_interval(mins => $1)
         RETURNING id, workspace_id
            """,
            max_age_minutes,
        )
    for row in rows:
        try:
            await publish_status(str(row["workspace_id"]), {
                "run_id": str(row["id"]),
                "status": "failed",
                "message": "Agent stopped: the run did not finish in time. Please start it again.",
            })
        except Exception:  # the row is already failed; a missed notification must not stop the sweep
            log.warning("could not publish reaped run %s", row["id"], exc_info=True)
    if rows:
        log.warning("marked %d stuck agent run(s) as failed", len(rows))
    return len(rows)


async def reaper_loop(pool: asyncpg.Pool) -> None:
    while True:
        try:
            await reap_stuck_runs(pool)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("agent run reaper sweep failed")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
