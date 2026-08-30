"""
agents/runner.py — Async background task runner for the LangGraph agent.

FastAPI background tasks don't block the HTTP response. If an error occurs
here, we catch it and publish it via Redis so the UI doesn't hang forever.
"""

import traceback
import asyncpg
from redis_client import publish_status

# Import our compiled graph builder
from .study_coach_graph import build_study_coach_graph


async def run_study_coach_background(
    run_id: str,
    workspace_id: str,
    user_id: str,
    goal: str,
    pool: asyncpg.Pool
) -> None:
    """
    Executes the Study Coach StateGraph from start to end.
    Designed to be run via FastAPI BackgroundTasks.
    """
    try:
        # Build the graph dynamically (it's fast)
        graph = build_study_coach_graph()
        
        # This initial dictionary must match the StudyCoachState TypedDict keys.
        initial_state = {
            "workspace_id": workspace_id,
            "user_id": user_id,
            "run_id": run_id,
            "goal": goal,
            "pool": pool,
            # Initialize empty fields that nodes will fill
            "topics": [],
            "plan": None,
            "approved": False,
            "materials": None,
            "status": "started"
        }
        
        # ainvoke() runs the entire graph head-to-tail
        # It pauses at await_approval until the Redis key appears, then resumes.
        await graph.ainvoke(initial_state)
        
    except Exception as e:
        # If any node throws an exception, catch it here at the top level
        print(f"[{run_id}] Agent graph failed: {e}")
        traceback.print_exc()
        
        # Tell the frontend that we failed
        await publish_status(workspace_id, {
            "run_id": run_id,
            "status": "failed",
            "message": f"Agent error: {str(e)}"
        })
        
        # Also mark it failed in the DB
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE agent_runs 
                SET status = 'failed', finished_at = NOW()
                WHERE id = $1
                """,
                run_id
            )
