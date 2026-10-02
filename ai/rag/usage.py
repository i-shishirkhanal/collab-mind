"""rag/usage.py — Best-effort recording of which provider/model served each
request and its token usage. A recording failure never fails the request."""

from __future__ import annotations

import logging
from typing import Optional

import asyncpg

from llm.types import Route, Usage

log = logging.getLogger("collabmind.usage")


async def record_usage(
    pool: Optional[asyncpg.Pool],
    *,
    workspace_id: str,
    user_id: Optional[str],
    kind: str,
    task: str,
    route: Route,
    usage: Usage,
) -> None:
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO llm_usage
                    (workspace_id, user_id, kind, task, provider, tier, model_requested, model_used,
                     prompt_tokens, completion_tokens, total_tokens, reasoning_tokens,
                     latency_ms, attempts, fallback_used, fallback_reason)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                """,
                workspace_id, user_id, kind, task, route.provider, route.tier.value,
                route.model_requested, route.model_used,
                usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, usage.reasoning_tokens,
                route.latency_ms, route.attempts, route.fallback_used, route.fallback_reason,
            )
    except Exception as exc:  # noqa: BLE001 — telemetry must not break answers
        log.warning("Could not record LLM usage: %s", type(exc).__name__)
