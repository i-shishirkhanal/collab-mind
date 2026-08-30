"""
redis_client.py — Async Redis client for pub/sub status updates.

The LangGraph agent runs as a background task. It uses Redis pub/sub
to broadcast its progress (e.g., 'analyzing', 'awaiting_approval', 'completed')
so the Node.js backend can push these events to the frontend via Socket.io.
"""

import os
import json
import redis.asyncio as redis


# Module-level singleton
_redis_pool: redis.Redis | None = None


async def get_redis() -> redis.Redis:
    """
    Return the shared async Redis client, creating it on first call.
    """
    global _redis_pool

    if _redis_pool is None:
        # Default to localhost if REDIS_URL is not provided in env.
        redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
        # decode_responses=True means we get back str instead of bytes
        _redis_pool = redis.from_url(redis_url, decode_responses=True)

    return _redis_pool


async def publish_status(workspace_id: str, payload: dict) -> None:
    """
    Helper to publish a JSON message to a workspace's agent channel.

    Node.js subscribes to: `workspace:{workspace_id}:agents`
    """
    r = await get_redis()
    channel = f"workspace:{workspace_id}:agents"
    # Convert Python dict to JSON string for Redis
    message = json.dumps(payload)
    await r.publish(channel, message)


async def close_redis() -> None:
    """Graceful shutdown for the Redis pool."""
    global _redis_pool
    if _redis_pool is not None:
        await _redis_pool.close()
        _redis_pool = None
