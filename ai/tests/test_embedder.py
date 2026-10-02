"""embed_source persistence behaviour, using a fake asyncpg pool that records
every statement so we can assert exactly what would be written."""

import asyncio
import json

import pytest

from rag import embedder
from rag.pipeline import _extract_citations


class _Tx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeConn:
    def __init__(self):
        self.calls = []
        self.source_url = None      # what the "sources" row says the file location is
        self.source_exists = True   # False = row missing at verification time
        self.deleted_midway = False  # True = row vanishes before the final lock

    async def execute(self, sql, *args):
        self.calls.append((" ".join(sql.split()), args))

    async def fetchrow(self, sql, *args):
        sql = " ".join(sql.split())
        self.calls.append((sql, args))
        if "FOR UPDATE" in sql:
            return None if self.deleted_midway else {"id": args[0]}
        return {"url": self.source_url} if self.source_exists else None

    def transaction(self):
        return _Tx()


class FakePool:
    def __init__(self):
        self.conn = FakeConn()

    def acquire(self):
        conn = self.conn

        class _Ctx:
            async def __aenter__(self_):
                return conn

            async def __aexit__(self_, *exc):
                return False

        return _Ctx()


@pytest.fixture(autouse=True)
def isolate(monkeypatch, tmp_path):
    class FakeEmbeddingClient:
        model = "bge-m3-test"
        dimensions = 1024

        def check_configured(self):
            pass

    async def fake_embed(texts):
        return [[0.0] * 1024 for _ in texts]

    async def no_publish(*args, **kwargs):
        return None

    monkeypatch.setattr(embedder, "_embed_texts", fake_embed)
    monkeypatch.setattr(embedder, "get_embedding_client", lambda: FakeEmbeddingClient())
    monkeypatch.setattr(embedder, "_publish", no_publish)
    monkeypatch.setattr(embedder, "UPLOADS_DIR", tmp_path.resolve())


def _run(pool, path):
    url = f"local://{path}"
    pool.conn.source_url = url
    return asyncio.run(embedder.embed_source(pool, "ws-1", "src-1", url))


def _inserts(pool):
    return [args for sql, args in pool.conn.calls if sql.startswith("INSERT INTO source_chunks")]


def _status_updates(pool):
    # Terminal writes only (ready/failed), not the per-stage progress markers.
    return [(sql, args) for sql, args in pool.conn.calls
            if sql.startswith("UPDATE sources") and ("'ready'" in sql or "'failed'" in sql)]


def _stages(pool):
    return [json.loads(args[2])["stage"] for sql, args in pool.conn.calls
            if sql.startswith("UPDATE sources") and "'processing'" in sql]


def test_pdf_chunks_are_stored_with_real_page_numbers_and_labels(tmp_path, pdf_bytes):
    f = tmp_path / "paper.pdf"
    f.write_bytes(pdf_bytes(["Page one text.", "Page two text.", "Page three text."]))
    pool = FakePool()

    assert _run(pool, f) == 3

    # args: workspace, source, chunk_index, content, page_number, location_label, vector
    rows = _inserts(pool)
    assert [(r[2], r[4], r[5]) for r in rows] == [(0, 1, "Page 1"), (1, 2, "Page 2"), (2, 3, "Page 3")]
    assert "ready" in _status_updates(pool)[-1][0]


def test_reprocessing_deletes_previous_chunks_before_inserting(tmp_path, pdf_bytes):
    f = tmp_path / "paper.pdf"
    f.write_bytes(pdf_bytes(["Some text."]))
    pool = FakePool()
    _run(pool, f)

    statements = [sql for sql, _ in pool.conn.calls]
    delete_at = next(i for i, s in enumerate(statements) if s.startswith("DELETE FROM source_chunks"))
    insert_at = next(i for i, s in enumerate(statements) if s.startswith("INSERT INTO source_chunks"))
    assert delete_at < insert_at


def test_plain_text_is_stored_without_invented_page_or_label(tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("Just some notes about plants.")
    pool = FakePool()

    assert _run(pool, f) == 1
    row = _inserts(pool)[0]
    assert row[4] is None and row[5] is None


def test_scanned_pdf_is_marked_failed_with_a_reason_and_stores_nothing(tmp_path, pdf_bytes):
    f = tmp_path / "scan.pdf"
    f.write_bytes(pdf_bytes(["", ""]))
    pool = FakePool()

    assert _run(pool, f) == 0
    assert _inserts(pool) == []
    sql, args = _status_updates(pool)[-1]
    assert "'failed'" in sql
    assert "scanned" in json.loads(args[2])["error"]


def test_corrupt_file_is_marked_failed_not_ready(tmp_path):
    f = tmp_path / "broken.pdf"
    f.write_bytes(b"%PDF-1.4 garbage")
    pool = FakePool()

    assert _run(pool, f) == 0
    assert "'failed'" in _status_updates(pool)[-1][0]
    assert _inserts(pool) == []


def test_file_outside_uploads_dir_is_refused_and_not_read(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP SECRET")
    monkeypatch.setattr(embedder, "UPLOADS_DIR", uploads.resolve())
    pool = FakePool()

    assert _run(pool, secret) == 0
    assert _inserts(pool) == []
    assert "not allowed" in json.loads(_status_updates(pool)[-1][1][2])["error"]


def test_path_traversal_out_of_uploads_dir_is_refused(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (tmp_path / "secret.txt").write_text("TOP SECRET")
    monkeypatch.setattr(embedder, "UPLOADS_DIR", uploads.resolve())
    pool = FakePool()

    assert asyncio.run(embedder.embed_source(pool, "ws-1", "src-1", f"local://{uploads}/../secret.txt")) == 0
    assert _inserts(pool) == []


# ── Citations carry exactly what was stored, never more ──────────────────────

def test_citations_expose_stored_page_and_label_and_do_not_invent_them():
    chunks = [
        {"source_name": "paper.pdf", "chunk_index": 0, "content": "x" * 400, "page_number": 4, "location_label": "Page 4"},
        {"source_name": "deck.pptx", "chunk_index": 1, "content": "slide text", "page_number": None, "location_label": "Slide 2"},
        {"source_name": "notes.txt", "chunk_index": 2, "content": "plain", "page_number": None, "location_label": None},
    ]
    c = _extract_citations(chunks)
    assert (c[0].page_number, c[0].location_label) == (4, "Page 4")
    assert (c[1].page_number, c[1].location_label) == (None, "Slide 2")
    assert (c[2].page_number, c[2].location_label) == (None, None)
    assert c[0].excerpt.endswith("…") and c[1].excerpt == "slide text"
