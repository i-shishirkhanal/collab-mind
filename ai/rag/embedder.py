"""
rag/embedder.py — Loads a source (uploaded file or web link), extracts
location-aware text, chunks it, embeds each chunk, and stores the chunks in
pgvector.

Text extraction itself lives in rag/extractor.py (MarkItDown) and chunking in
rag/chunker.py; this module owns storage access, embeddings and persistence.

Lifecycle (sources.status / sources.metadata.stage):
    processing / queued -> extracting -> chunking -> embedding -> storing -> ready
    processing / ...    -> failed (metadata.error holds a user-safe reason)
A source only becomes 'ready' inside the same transaction that writes its
chunks, so 'ready' always means the chunks are really there.
"""

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import asyncpg
import google.generativeai as genai

from rag.chunker import chunk_blocks
from rag.extractor import Block, ExtractionError, extract_blocks, extract_url

EMBED_MODEL = "models/text-embedding-004"
EMBED_DIMENSIONS = 768  # must match source_chunks.embedding vector(768)

# Uploaded files may only be read from the shared uploads directory, so a
# crafted storage_url can't make the service index arbitrary files on disk.
UPLOADS_DIR = Path(os.environ.get("UPLOADS_DIR", "/app/uploads")).resolve()
MAX_FILE_BYTES = 60 * 1024 * 1024
EXTRACTION_TIMEOUT_SECONDS = float(os.environ.get("EXTRACTION_TIMEOUT_SECONDS", "180"))

try:
    from google.cloud import storage as gcs
except ImportError:
    gcs = None


class EmbeddingError(Exception):
    """Embeddings could not be produced. The message is safe to show users."""


def _read_local_file(path_text: str) -> tuple[bytes, str]:
    path = Path(path_text).resolve()
    if UPLOADS_DIR != path and UPLOADS_DIR not in path.parents:
        raise ExtractionError("That file location is not allowed.")
    if not path.is_file():
        raise ExtractionError("The uploaded file could not be found.")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ExtractionError("That file is too large to process.")
    return path.read_bytes(), path.name


def _read_gcs_file(storage_url: str) -> tuple[bytes, str]:
    if gcs is None:
        raise ExtractionError("Cloud storage is not available on this server.")
    bucket_name, _, object_name = storage_url.removeprefix("gs://").partition("/")
    blob = gcs.Client().bucket(bucket_name).blob(object_name)
    data = blob.download_as_bytes()
    if len(data) > MAX_FILE_BYTES:
        raise ExtractionError("That file is too large to process.")
    return data, object_name.rsplit("/", 1)[-1]


def load_blocks(storage_url: str) -> list[Block]:
    """Blocking: fetch + parse a source into location-aware blocks. Raises
    ExtractionError (safe message) when it can't be read."""
    if storage_url.startswith(("http://", "https://")):
        return extract_url(storage_url)

    if storage_url.startswith("gs://"):
        data, filename = _read_gcs_file(storage_url)
    else:
        data, filename = _read_local_file(
            storage_url.removeprefix("local://").removeprefix("file://")
        )
    return extract_blocks(data, filename)


# ── Embeddings ────────────────────────────────────────────────────────────────

def _has_real_embedding_key() -> bool:
    key = os.environ.get("GEMINI_API_KEY", "")
    return bool(key) and not key.startswith("dummy")


def _dev_embeddings_allowed() -> bool:
    return os.environ.get("ALLOW_DEV_EMBEDDINGS", "").lower() in ("1", "true", "yes")


def embedding_mode() -> str:
    """'gemini' with a real key; 'dev-hash' only when explicitly opted in
    (vectors are a hash of the text, NOT semantic); otherwise raises, so a
    document is never marked ready with embeddings that mean nothing."""
    if _has_real_embedding_key():
        return "gemini"
    if _dev_embeddings_allowed():
        return "dev-hash"
    raise EmbeddingError(
        "No embedding model is configured on the server, so this document can't be indexed yet."
    )


def _embed_text_sync(text: str) -> list[float]:
    if embedding_mode() == "gemini":
        try:
            vector = genai.embed_content(
                model=EMBED_MODEL, content=text, task_type="RETRIEVAL_DOCUMENT"
            )["embedding"]
        except Exception as exc:
            print(f"[Embedder] Gemini embed call failed: {exc!r}")
            raise EmbeddingError("The embedding service failed. Please retry.") from exc
        if len(vector) != EMBED_DIMENSIONS:
            raise EmbeddingError("The embedding service returned an unexpected vector size.")
        return vector

    import hashlib
    h = hashlib.sha256(text.encode("utf-8")).digest()
    vec = [((h[i % len(h)] / 255.0) * 2.0 - 1.0) for i in range(EMBED_DIMENSIONS)]
    norm = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / norm for x in vec]


async def _embed_text(text: str) -> list[float]:
    # The Gemini SDK call is blocking; keep it off the event loop.
    return await asyncio.to_thread(_embed_text_sync, text)


# ── Status / progress ────────────────────────────────────────────────────────

async def _publish(workspace_id: str, event: str, source_id: str, status: str) -> None:
    try:
        from redis_client import get_redis
        redis = await get_redis()
        await redis.publish("ai_updates", json.dumps({
            "workspaceId": workspace_id,
            "type": event,
            "data": {"source_id": source_id, "status": status},
        }))
    except Exception as e:
        print(f"[Embedder] Redis publish warning: {e}")


async def _set_stage(pool: asyncpg.Pool, workspace_id: str, source_id: str, stage: str) -> None:
    """Progress marker readable through the sources API (metadata.stage)."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE sources
            SET    metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                   updated_at = NOW()
            WHERE  id = $1 AND workspace_id = $2 AND status = 'processing'
            """,
            source_id,
            workspace_id,
            json.dumps({"stage": stage}),
        )
    await _publish(workspace_id, "source:progress", source_id, "processing")


async def _mark_failed(pool: asyncpg.Pool, workspace_id: str, source_id: str, message: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE sources
            SET    status = 'failed',
                   metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                   updated_at = NOW()
            WHERE  id = $1 AND workspace_id = $2
            """,
            source_id,
            workspace_id,
            json.dumps({"error": message, "stage": "failed"}),
        )
    await _publish(workspace_id, "source:failed", source_id, "failed")


async def _verify_source(pool: asyncpg.Pool, workspace_id: str, source_id: str, storage_url: str) -> None:
    """The caller's workspace/source/url triple must match what the backend
    recorded, so a request can't make the service index one workspace's file
    under another workspace's source."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT url FROM sources WHERE id = $1 AND workspace_id = $2",
            source_id,
            workspace_id,
        )
    if row is None:
        raise ExtractionError("This source no longer exists.")
    if row["url"] != storage_url:
        raise ExtractionError("That file location does not belong to this source.")


async def embed_source(
    pool: asyncpg.Pool,
    workspace_id: str,
    source_id: str,
    storage_url: str,
) -> int:
    """Process one source end to end. Safe to call again for the same source
    (retries, double clicks): chunks are replaced atomically, never appended.
    Returns the chunk count, or 0 after recording a failure."""
    try:
        await _verify_source(pool, workspace_id, source_id, storage_url)
        mode = embedding_mode()  # fail before doing any work if embeddings are impossible

        await _set_stage(pool, workspace_id, source_id, "extracting")
        blocks = await asyncio.wait_for(
            asyncio.to_thread(load_blocks, storage_url),
            timeout=EXTRACTION_TIMEOUT_SECONDS,
        )

        await _set_stage(pool, workspace_id, source_id, "chunking")
        chunks = chunk_blocks(blocks)
        if not chunks:
            raise ExtractionError("No readable text was found in this file.")

        # Embed first so a database connection isn't held during slow API calls.
        await _set_stage(pool, workspace_id, source_id, "embedding")
        vectors = [await _embed_text(chunk.text) for chunk in chunks]

        await _set_stage(pool, workspace_id, source_id, "storing")
        summary = {
            "stage": "ready",
            "chunk_count": len(chunks),
            "char_count": sum(len(c.text) for c in chunks),
            "page_count": len({c.page_number for c in chunks if c.page_number is not None}) or None,
            "embedding_mode": mode,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }

        async with pool.acquire() as conn:
            async with conn.transaction():
                # Lock the source row: concurrent runs for the same source
                # queue up here, and a source deleted meanwhile is detected.
                locked = await conn.fetchrow(
                    "SELECT id FROM sources WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
                    source_id,
                    workspace_id,
                )
                if locked is None:
                    raise ExtractionError("This source no longer exists.")

                # Re-processing replaces the previous run's chunks.
                await conn.execute(
                    "DELETE FROM source_chunks WHERE source_id = $1 AND workspace_id = $2",
                    source_id,
                    workspace_id,
                )
                for idx, (chunk, vector) in enumerate(zip(chunks, vectors)):
                    await conn.execute(
                        """
                        INSERT INTO source_chunks
                            (workspace_id, source_id, chunk_index, content,
                             page_number, location_label, embedding)
                        VALUES
                            ($1, $2, $3, $4, $5, $6, $7::vector)
                        """,
                        workspace_id,
                        source_id,
                        idx,
                        chunk.text,
                        chunk.page_number,
                        chunk.location_label,
                        str(vector),
                    )

                await conn.execute(
                    """
                    UPDATE sources
                    SET    status = 'ready',
                           metadata = (COALESCE(metadata, '{}'::jsonb) - 'error') || $3::jsonb,
                           updated_at = NOW()
                    WHERE  id = $1 AND workspace_id = $2
                    """,
                    source_id,
                    workspace_id,
                    json.dumps(summary),
                )

        await _publish(workspace_id, "source:ready", source_id, "ready")
        return len(chunks)

    except (ExtractionError, EmbeddingError) as exc:
        print(f"[Embedder] Source {source_id} failed: {exc}")
        await _mark_failed(pool, workspace_id, source_id, str(exc))
        return 0
    except asyncio.TimeoutError:
        print(f"[Embedder] Source {source_id} timed out after {EXTRACTION_TIMEOUT_SECONDS}s")
        await _mark_failed(pool, workspace_id, source_id, "Processing took too long and was stopped.")
        return 0
    except Exception as exc:
        print(f"[Embedder Error] Failed embedding source {source_id}: {exc!r}")
        await _mark_failed(pool, workspace_id, source_id, "Processing failed unexpectedly. Please try again.")
        return 0
