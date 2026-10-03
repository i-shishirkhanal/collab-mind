"""Unit tests (no database): the stuck-run reaper and the read-only schema check."""

import asyncio
import uuid

import db
from agents import reaper
from llm_helpers import settings


class _Conn:
    def __init__(self, fetch_result=None, fetchval_result=None):
        self.fetch_result = fetch_result or []
        self.fetchval_result = fetchval_result
        self.queries = []

    async def fetch(self, sql, *args):
        self.queries.append(sql)
        return self.fetch_result

    async def fetchval(self, sql, *args):
        self.queries.append(sql)
        return self.fetchval_result

    async def execute(self, sql, *args):  # DDL would land here; the check must never call it
        raise AssertionError("schema check must be read-only")


class _Pool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        conn = self.conn

        class _Ctx:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *exc):
                return False

        return _Ctx()


def test_reaper_fails_stuck_runs_and_notifies_the_workspace(monkeypatch):
    run, ws = uuid.uuid4(), uuid.uuid4()
    published = []

    async def fake_publish(workspace_id, payload):
        published.append((workspace_id, payload))

    monkeypatch.setattr(reaper, "publish_status", fake_publish)
    conn = _Conn(fetch_result=[{"id": run, "workspace_id": ws}])

    assert asyncio.run(reaper.reap_stuck_runs(_Pool(conn))) == 1
    assert "status NOT IN ('completed', 'failed')" in conn.queries[0]
    assert published == [(str(ws), {"run_id": str(run), "status": "failed", "message": published[0][1]["message"]})]


def test_reaper_survives_a_failed_notification(monkeypatch):
    async def boom(*a, **k):
        raise ConnectionError("redis down")

    monkeypatch.setattr(reaper, "publish_status", boom)
    conn = _Conn(fetch_result=[{"id": uuid.uuid4(), "workspace_id": uuid.uuid4()}])
    assert asyncio.run(reaper.reap_stuck_runs(_Pool(conn))) == 1


def _all_columns():
    return [{"table_name": t, "column_name": c} for t, cols in db._REQUIRED_COLUMNS.items() for c in cols]


def test_schema_check_passes_when_migrated(monkeypatch):
    monkeypatch.setattr(db, "get_settings", lambda: settings())
    pool = _Pool(_Conn(fetch_result=_all_columns(), fetchval_result=1024))
    asyncio.run(db.ensure_schema(pool))
    assert db.SCHEMA_PROBLEM is None


def test_schema_check_reports_missing_migration_columns(monkeypatch):
    monkeypatch.setattr(db, "get_settings", lambda: settings())
    cols = [c for c in _all_columns() if c["column_name"] != "finished_at"]
    try:
        asyncio.run(db.ensure_schema(_Pool(_Conn(fetch_result=cols, fetchval_result=1024))))
        assert db.SCHEMA_PROBLEM and "agent_runs.finished_at" in db.SCHEMA_PROBLEM
    finally:
        db.SCHEMA_PROBLEM = None


def test_schema_check_reports_dimension_mismatch(monkeypatch):
    monkeypatch.setattr(db, "get_settings", lambda: settings())
    try:
        asyncio.run(db.ensure_schema(_Pool(_Conn(fetch_result=_all_columns(), fetchval_result=768))))
        assert db.SCHEMA_PROBLEM and "768" in db.SCHEMA_PROBLEM
    finally:
        db.SCHEMA_PROBLEM = None
