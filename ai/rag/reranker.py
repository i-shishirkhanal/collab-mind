"""
rag/reranker.py — optional cross-encoder rerank of retrieved candidates.

Retrieval (BGE-M3 + FTS, fused by RRF) is a fast first stage. A cross-encoder reads the query and each
passage together and scores their relevance directly, which is slower but usually ranks better. It is
OFF by default (RERANKER_ENABLED) and never makes a request fail: if the model cannot load or scoring
raises, the retrieval order is kept and the problem is logged.

The model is a sentence-transformers CrossEncoder (a local path or hub id, see ml/train_reranker.py).
`torch`/`sentence-transformers` are optional dependencies (requirements-ml.txt) imported lazily.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional, Protocol, Sequence

from config import RetrievalSettings

log = logging.getLogger("collabmind.reranker")

MAX_PASSAGE_CHARS = 2000   # cross-encoders truncate anyway; this keeps tokenisation cheap


class Scorer(Protocol):
    def score(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]: ...


class _CrossEncoderScorer:
    """Thin wrapper so the heavy import and model load happen on first use only."""

    def __init__(self, model_name: str):
        from sentence_transformers import CrossEncoder   # optional dependency

        self._model = CrossEncoder(model_name, max_length=512)

    def score(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]:
        return [float(x) for x in self._model.predict(list(pairs), show_progress_bar=False)]


_scorer: Optional[Scorer] = None
_load_failed_for: Optional[str] = None


def set_scorer(scorer: Optional[Scorer]) -> None:
    """Test hook: install (or clear) the scorer."""
    global _scorer, _load_failed_for
    _scorer = scorer
    _load_failed_for = None


def _get_scorer(model_name: str) -> Optional[Scorer]:
    global _scorer, _load_failed_for
    if _scorer is not None:
        return _scorer
    if _load_failed_for == model_name:
        return None   # do not retry (and re-log) a failing load on every request
    try:
        _scorer = _CrossEncoderScorer(model_name)
    except Exception:  # noqa: BLE001 — missing dependency, bad path, no network: all mean "no reranking"
        _load_failed_for = model_name
        log.warning("reranker %r could not be loaded; keeping retrieval order", model_name, exc_info=True)
        return None
    return _scorer


@dataclass
class RerankInfo:
    applied: bool
    candidates: int
    latency_ms: int
    fallback_reason: Optional[str] = None


def candidates_needed(cfg: RetrievalSettings, top_k: int) -> int:
    """How many chunks retrieval should return so the reranker has something to choose from."""
    return max(top_k, cfg.reranker_candidates) if cfg.reranker_enabled else top_k


async def rerank_chunks(cfg: RetrievalSettings, query: str, chunks: list[dict], top_k: int
                        ) -> tuple[list[dict], RerankInfo]:
    """Best `top_k` chunks by cross-encoder score (each gets `rerank_score`); on any problem the original
    order is kept and cut to `top_k`."""
    start = time.perf_counter()
    if not cfg.reranker_enabled or len(chunks) <= 1:
        return chunks[:top_k], RerankInfo(False, len(chunks), 0)
    scorer = _get_scorer(cfg.reranker_model)
    if scorer is None:
        return chunks[:top_k], RerankInfo(False, len(chunks), 0, "model unavailable")
    pairs = [(query, c["content"][:MAX_PASSAGE_CHARS]) for c in chunks]
    try:
        scores = await asyncio.to_thread(scorer.score, pairs)   # CPU-bound: keep the event loop free
        if len(scores) != len(chunks):
            raise ValueError("scorer returned the wrong number of scores")
    except Exception:  # noqa: BLE001
        log.warning("reranking failed; keeping retrieval order", exc_info=True)
        return chunks[:top_k], RerankInfo(False, len(chunks), 0, "scoring failed")
    ranked = sorted(zip(chunks, scores), key=lambda cs: cs[1], reverse=True)
    out = [{**c, "rerank_score": float(s)} for c, s in ranked[:top_k]]
    return out, RerankInfo(True, len(chunks), int((time.perf_counter() - start) * 1000))
