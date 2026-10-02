"""Processing lifecycle: ready only after genuine success, safe retries, and
source verification. Uses the recording fake pool from test_embedder.py."""

import asyncio
import json

from llm.errors import EmbeddingUnavailableError
from rag import embedder
from tests.test_embedder import FakePool, _inserts, _run, _stages, _status_updates, isolate  # noqa: F401


def test_ready_update_records_stage_trail_and_real_metadata(tmp_path, pdf_bytes):
    f = tmp_path / "paper.pdf"
    f.write_bytes(pdf_bytes(["Page one text.", "Page two text."]))
    pool = FakePool()
    _run(pool, f)

    assert _stages(pool) == ["extracting", "chunking", "embedding", "storing"]
    sql, args = _status_updates(pool)[-1]
    meta = json.loads(args[2])
    assert meta["stage"] == "ready" and meta["chunk_count"] == 2 and meta["page_count"] == 2
    assert meta["embedding_model"] == "bge-m3-test" and "processed_at" in meta
    assert "- 'error'" in sql  # a previous failure message is cleared on success


def test_embedding_outage_stores_nothing_and_is_not_ready(tmp_path, monkeypatch):
    f = tmp_path / "notes.txt"
    f.write_text("word " * 2000)  # several chunks

    async def down(texts):
        raise EmbeddingUnavailableError("provider down")

    monkeypatch.setattr(embedder, "_embed_texts", down)
    pool = FakePool()

    assert _run(pool, f) == 0
    assert _inserts(pool) == []
    # Nothing was deleted either: a failed retry must not wipe previously good chunks.
    assert not any(s.startswith("DELETE FROM source_chunks") for s, _ in pool.conn.calls)
    sql, args = _status_updates(pool)[-1]
    assert "'failed'" in sql and "embedding service" in json.loads(args[2])["error"]


def test_vector_count_mismatch_is_a_failure_not_a_partial_success(tmp_path, monkeypatch):
    f = tmp_path / "notes.txt"
    f.write_text("word " * 2000)

    async def short(texts):
        return [[0.0] * 1024]

    monkeypatch.setattr(embedder, "_embed_texts", short)
    pool = FakePool()

    assert _run(pool, f) == 0
    assert _inserts(pool) == []
    assert "'failed'" in _status_updates(pool)[-1][0]


def test_retry_after_failure_succeeds_and_replaces_chunks(tmp_path, monkeypatch):
    f = tmp_path / "notes.txt"
    f.write_text("Plants make sugar from light.")
    pool = FakePool()

    good = embedder._embed_texts

    async def down(texts):
        raise EmbeddingUnavailableError("provider down")

    monkeypatch.setattr(embedder, "_embed_texts", down)
    assert _run(pool, f) == 0
    monkeypatch.setattr(embedder, "_embed_texts", good)
    assert _run(pool, f) == 1
    assert _run(pool, f) == 1  # a further retry is harmless

    deletes = [s for s, _ in pool.conn.calls if s.startswith("DELETE FROM source_chunks")]
    # Each successful run deletes before inserting, so chunk_index (part of the PK) can't collide.
    assert len(deletes) == 2
    assert len(_inserts(pool)) == 2 and {r[2] for r in _inserts(pool)} == {0}
    assert "ready" in _status_updates(pool)[-1][0]


def test_source_deleted_while_processing_is_not_resurrected(tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("Some text.")
    pool = FakePool()
    pool.conn.deleted_midway = True

    assert _run(pool, f) == 0
    assert _inserts(pool) == []


def test_unknown_source_is_rejected_without_reading_the_file(tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("Some text.")
    pool = FakePool()
    pool.conn.source_exists = False

    assert _run(pool, f) == 0
    assert _inserts(pool) == []


def test_storage_url_not_matching_the_source_record_is_refused(tmp_path):
    f = tmp_path / "other-workspace.txt"
    f.write_text("Another workspace's document.")
    pool = FakePool()
    pool.conn.source_url = "local:///somewhere/else.txt"

    assert asyncio.run(embedder.embed_source(pool, "ws-1", "src-1", f"local://{f}")) == 0
    assert _inserts(pool) == []
    assert "does not belong" in json.loads(_status_updates(pool)[-1][1][2])["error"]
