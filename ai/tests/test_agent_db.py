"""Phase 4 regression (real Postgres, skipped without TEST_DATABASE_URL): the study-coach graph's final
UPDATE referenced agent_runs.finished_at, a column no migration created, so runs could never complete."""

import asyncio
import json
import os
import uuid

import pytest

DSN = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

asyncpg = pytest.importorskip("asyncpg")
import uuid_shim  # noqa: E402,F401
import agents.study_coach_graph as graph  # noqa: E402
from agents import runner  # noqa: E402


async def _noop(*a, **k):
    return None


def test_save_results_and_failure_path_write_finished_at(monkeypatch):
    monkeypatch.setattr(graph, "publish_status", _noop)
    monkeypatch.setattr(runner, "publish_status", _noop)

    async def go():
        pool = await asyncpg.create_pool(DSN, min_size=1, max_size=2)
        u, w, ok_run, bad_run = (str(uuid.uuid4()) for _ in range(4))
        try:
            async with pool.acquire() as c:
                await c.execute("INSERT INTO users(id,name,email) VALUES ($1,'t',$2)", u, u + "@t.io")
                await c.execute("INSERT INTO workspaces(id,name,created_by) VALUES ($1,'t',$2)", w, u)
                for r in (ok_run, bad_run):
                    await c.execute("INSERT INTO agent_runs(id,workspace_id,agent_type,status) VALUES ($1,$2,'study_coach','started')", r, w)

            await graph.save_results({"workspace_id": w, "run_id": ok_run, "plan": "P", "materials": "M", "pool": pool})
            monkeypatch.setattr(runner, "build_study_coach_graph", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
            await runner.run_study_coach_background(bad_run, w, u, "goal", pool)

            async with pool.acquire() as c:
                done = await c.fetchrow("SELECT status, result, finished_at FROM agent_runs WHERE id=$1", ok_run)
                failed = await c.fetchrow("SELECT status, finished_at FROM agent_runs WHERE id=$1", bad_run)
            assert done["status"] == "completed" and done["finished_at"] is not None
            assert json.loads(done["result"]) == {"plan": "P", "materials": "M"}
            assert failed["status"] == "failed" and failed["finished_at"] is not None
        finally:
            async with pool.acquire() as c:
                await c.execute("DELETE FROM workspaces WHERE id=$1", w)
                await c.execute("DELETE FROM users WHERE id=$1", u)
            await pool.close()

    asyncio.run(go())
