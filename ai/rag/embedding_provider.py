"""
rag/embedding_provider.py — BGE-M3 dense embeddings over an OpenAI-compatible
`/embeddings` endpoint.

BGE-M3 (BAAI/bge-m3, MIT) facts this module relies on:
  * dense vectors are 1024-d, input up to 8192 tokens;
  * documents and queries use the SAME model and NO instruction prefix, so
    `embed_documents` and `embed_query` are intentionally configured
    identically (one code path, one config);
  * the dense output is meant for cosine similarity. Hosted/TEI servers
    normally return unit vectors; we verify and L2-normalise if they do not,
    so pgvector's cosine distance is always meaningful.

Compatible servers: HuggingFace Text-Embeddings-Inference (`/v1/embeddings`),
vLLM, SiliconFlow (`https://api.siliconflow.com/v1`, model `BAAI/bge-m3`) and
any other OpenAI-style embeddings API. See docs/AI_PHASE3.md.

There is deliberately NO fallback: if the provider is down, misconfigured or
returns the wrong shape we raise EmbeddingUnavailableError. We never invent a
vector.
"""

from __future__ import annotations

import asyncio
import logging
import math
from typing import Callable, Awaitable, Optional

import httpx

from config import EmbeddingSettings, get_settings
from llm import errors
from llm.redaction import register_secret

log = logging.getLogger("collabmind.embeddings")
PROVIDER = "bge-m3"
NORM_TOLERANCE = 1e-3


class EmbeddingClient:
    def __init__(self, settings: EmbeddingSettings,
                 transport: Optional[httpx.AsyncBaseTransport] = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep):
        self._s = settings
        self._transport = transport
        self._sleep = sleep
        register_secret(settings.api_key)

    @property
    def model(self) -> str:
        return self._s.model

    @property
    def dimensions(self) -> int:
        return self._s.dimensions

    def _fail(self, message: str, status: int | None = None) -> errors.EmbeddingUnavailableError:
        return errors.EmbeddingUnavailableError(message, provider=PROVIDER, model=self._s.model, status=status)

    def _check_configured(self) -> None:
        if not self._s.base_url:
            raise errors.EmbeddingUnavailableError(
                "EMBEDDING_BASE_URL is not configured; BGE-M3 embeddings are unavailable.",
                provider=PROVIDER, model=self._s.model,
            )

    async def _post_batch(self, client: httpx.AsyncClient, texts: list[str]) -> list[list[float]]:
        attempts = 0
        while True:
            attempts += 1
            try:
                response = await client.post("/embeddings", json={
                    "model": self._s.model, "input": texts, "encoding_format": "float",
                })
            except httpx.TimeoutException:
                err = self._fail("Embedding request timed out.")
                transient = True
            except httpx.TransportError as exc:
                err = self._fail(f"Could not reach the embedding server ({type(exc).__name__}).")
                transient = True
            else:
                if response.status_code == 200:
                    return self._parse(response, len(texts))
                transient = response.status_code in (429, 500, 502, 503, 504)
                reason = {
                    401: "embedding server rejected the credentials",
                    403: "embedding server rejected the credentials",
                    404: f"model or endpoint not found (is '{self._s.model}' deployed?)",
                    429: "embedding server rate limit reached",
                }.get(response.status_code, f"embedding server returned HTTP {response.status_code}")
                err = self._fail(f"Embedding failed: {reason}.", response.status_code)
            if transient and attempts <= self._s.max_retries:
                await self._sleep(min(1.0 * 2 ** (attempts - 1), 15.0))
                continue
            raise err

    def _parse(self, response: httpx.Response, expected: int) -> list[list[float]]:
        try:
            items = sorted(response.json()["data"], key=lambda d: d["index"])
            vectors = [list(map(float, d["embedding"])) for d in items]
        except (ValueError, KeyError, TypeError):
            raise self._fail("Embedding server returned an unreadable response.") from None
        if len(vectors) != expected:
            raise self._fail(f"Embedding server returned {len(vectors)} vectors for {expected} inputs.")
        out = []
        for vec in vectors:
            if len(vec) != self._s.dimensions:
                raise self._fail(
                    f"Embedding dimension mismatch: server returned {len(vec)}, "
                    f"expected {self._s.dimensions} (EMBEDDING_DIM / pgvector column)."
                )
            if not all(math.isfinite(x) for x in vec):
                raise self._fail("Embedding server returned non-finite values.")
            norm = math.sqrt(sum(x * x for x in vec))
            if norm == 0:
                raise self._fail("Embedding server returned an all-zero vector.")
            if abs(norm - 1.0) > NORM_TOLERANCE:
                vec = [x / norm for x in vec]
            out.append(vec)
        return out

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        self._check_configured()
        if any(not t or not t.strip() for t in texts):
            raise self._fail("Cannot embed empty text.")
        headers = {"Content-Type": "application/json"}
        if self._s.api_key:
            headers["Authorization"] = f"Bearer {self._s.api_key}"
        result: list[list[float]] = []
        async with httpx.AsyncClient(
            base_url=self._s.base_url, headers=headers, transport=self._transport,
            timeout=httpx.Timeout(self._s.timeout_seconds, connect=10.0),
        ) as client:
            for i in range(0, len(texts), self._s.batch_size):
                result.extend(await self._post_batch(client, texts[i:i + self._s.batch_size]))
        return result

    # Same configuration for both directions — see module docstring.
    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return await self.embed(texts)

    async def embed_query(self, text: str) -> list[float]:
        return (await self.embed([text]))[0]


_client: Optional[EmbeddingClient] = None


def get_embedding_client() -> EmbeddingClient:
    global _client
    if _client is None:
        _client = EmbeddingClient(get_settings().embedding)
    return _client


def set_embedding_client(client: Optional[EmbeddingClient]) -> None:
    global _client
    _client = client
