"""
rag/embedder.py — Downloads or reads a file, splits it into page-aware
                  overlapping text chunks, and embeds each chunk using
                  Gemini or vector fallback.
"""

import ipaddress
import os
import re
import socket
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Optional
from urllib.parse import urlparse

import asyncpg
import google.generativeai as genai
import httpx
import tiktoken


@dataclass
class Block:
    """One unit of extracted document content with its source page, if known.

    Chunking never spans two blocks, so a chunk's page_number is always
    exactly the page it came from — never an average or a guess.
    """
    text: str
    page_number: Optional[int] = None

CHUNK_SIZE = 512
CHUNK_OVERLAP = 50
EMBED_MODEL = "models/text-embedding-004"

try:
    from google.cloud import storage as gcs
except ImportError:
    gcs = None

_tokenizer = tiktoken.get_encoding("cl100k_base")

_SKIP_TAGS = {"script", "style", "noscript", "svg", "nav", "footer", "header"}
_MAX_URL_BYTES = 5 * 1024 * 1024  # 5MB response cap


class _TextExtractor(HTMLParser):
    """Minimal HTML→text extractor: strips tags/scripts, keeps visible text."""

    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self.chunks: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
        elif tag in ("br", "p", "div", "li", "tr"):
            self.chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth == 0 and data.strip():
            self.chunks.append(data.strip())

    def text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", " ".join(self.chunks))


def _is_safe_public_host(hostname: str) -> bool:
    """Basic SSRF guard: refuse hosts that resolve to private/loopback/link-local ranges."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


def _fetch_url_content(url: str) -> list[Block]:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return [Block(f"Source document: {url}")]
    if not _is_safe_public_host(parsed.hostname):
        print(f"[Embedder] Refusing to fetch non-public host: {parsed.hostname}")
        return [Block(f"Source document: {url}")]

    try:
        headers = {"User-Agent": "CollabMindBot/1.0 (+source ingestion)"}
        with httpx.Client(follow_redirects=True, timeout=15.0, headers=headers) as client:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                body = b""
                for part in response.iter_bytes():
                    body += part
                    if len(body) > _MAX_URL_BYTES:
                        break
        html_text = body.decode(response.encoding or "utf-8", errors="ignore")
        extractor = _TextExtractor()
        extractor.feed(html_text)
        text = extractor.text()
        # A web page has no page numbers to preserve — one page-less block.
        return [Block(text if text.strip() else f"Source document: {url}")]
    except Exception as exc:
        print(f"[Embedder] URL fetch failed for {url}: {exc}")
        return [Block(f"Source document: {url}")]


def _parse_pdf(path: str) -> list[Block]:
    """Extract text from a PDF one block per page, so citations can carry a
    real page number instead of leaving it null."""
    import pypdf
    reader = pypdf.PdfReader(path)
    blocks: list[Block] = []
    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        if text.strip():
            blocks.append(Block(text, page_number=page_number))
    return blocks


def _download_or_read_content(storage_url: str) -> list[Block]:
    if storage_url.startswith("http://") or storage_url.startswith("https://"):
        return _fetch_url_content(storage_url)

    if storage_url.startswith("gs://") and gcs is not None:
        try:
            path = storage_url.removeprefix("gs://")
            bucket_name, _, object_name = path.partition("/")
            client = gcs.Client()
            bucket = client.bucket(bucket_name)
            blob = bucket.blob(object_name)
            return [Block(blob.download_as_text(encoding="utf-8"))]
        except Exception as exc:
            print(f"[Embedder] GCS download failed: {exc}. Trying local file check...")

    clean_path = storage_url.replace("local://", "").replace("file://", "")
    if os.path.exists(clean_path):
        if clean_path.endswith(".pdf"):
            try:
                blocks = _parse_pdf(clean_path)
                if blocks:
                    return blocks
            except Exception as e:
                print(f"[Embedder] PDF parse warning: {e}")

        try:
            with open(clean_path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
                if text.strip():
                    return [Block(text)]
        except Exception as e:
            print(f"[Embedder] Text read error: {e}")

    return [Block(f"Source document: {os.path.basename(storage_url)}")]


def _chunk_blocks(blocks: list[Block]) -> list[Block]:
    """Token-size each block independently so a chunk never spans two pages;
    each output chunk inherits its source block's page_number verbatim."""
    if not blocks:
        blocks = [Block("Empty document content.")]

    step = CHUNK_SIZE - CHUNK_OVERLAP
    chunks: list[Block] = []

    for block in blocks:
        text = block.text if block.text.strip() else "Empty document content."
        token_ids = _tokenizer.encode(text)

        for start in range(0, len(token_ids), step):
            end = start + CHUNK_SIZE
            window = token_ids[start:end]
            chunks.append(Block(_tokenizer.decode(window), page_number=block.page_number))
            if end >= len(token_ids):
                break

    return chunks or [Block("Empty document content.")]


async def _embed_text(text: str) -> list[float]:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if api_key and not api_key.startswith("dummy"):
        try:
            result = genai.embed_content(
                model=EMBED_MODEL,
                content=text,
                task_type="RETRIEVAL_DOCUMENT",
            )
            return result["embedding"]
        except Exception as exc:
            print(f"[Embedder] Gemini API call failed ({exc}). Using deterministic vector fallback.")

    import hashlib
    h = hashlib.sha256(text.encode('utf-8')).digest()
    vec = [((h[i % len(h)] / 255.0) * 2.0 - 1.0) for i in range(768)]
    norm = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / norm for x in vec]


async def embed_source(
    pool: asyncpg.Pool,
    workspace_id: str,
    source_id: str,
    storage_url: str,
) -> int:
    try:
        blocks = _download_or_read_content(storage_url)
        chunks = _chunk_blocks(blocks)

        async with pool.acquire() as conn:
            async with conn.transaction():
                for idx, chunk in enumerate(chunks):
                    vector = await _embed_text(chunk.text)
                    await conn.execute(
                        """
                        INSERT INTO source_chunks
                            (workspace_id, source_id, chunk_index, content, page_number, embedding)
                        VALUES
                            ($1, $2, $3, $4, $5, $6::vector)
                        """,
                        workspace_id,
                        source_id,
                        idx,
                        chunk.text,
                        chunk.page_number,
                        str(vector),
                    )

                await conn.execute(
                    """
                    UPDATE sources
                    SET    status = 'ready'
                    WHERE  id = $1
                    AND    workspace_id = $2
                    """,
                    source_id,
                    workspace_id,
                )

        try:
            from redis_client import get_redis
            import json
            redis = await get_redis()
            await redis.publish("ai_updates", json.dumps({
                "workspaceId": workspace_id,
                "type": "source:ready",
                "data": { "source_id": source_id, "status": "ready" }
            }))
        except Exception as e:
            print(f"[Embedder] Redis publish warning: {e}")

        return len(chunks)
    except Exception as exc:
        print(f"[Embedder Error] Failed embedding source {source_id}: {exc}")
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE sources SET status = 'failed' WHERE id = $1 AND workspace_id = $2",
                source_id,
                workspace_id,
            )
        return 0
