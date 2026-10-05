"""
rag/injection.py — optional learned prompt-injection screen for retrieved passages.

Uploaded documents are attacker-controllable (any workspace member can add one), and grounding.py already fences them
as untrusted data. This is a second, learned layer: each retrieved passage is scanned in overlapping windows by a
fine-tuned DistilBERT (ml/injection/train_injection.py) and a passage whose worst window scores above the threshold is
WITHHELD from the model context, with a warning for the user. Detection never edits text and never blocks an upload.

OFF by default (INJECTION_DETECTOR_ENABLED) and fail-open: if the model cannot load or scoring raises, passages pass
through unchanged (the fence in grounding.py still applies) and the problem is logged. `torch`/`transformers` are
optional dependencies (requirements-ml.txt) imported lazily. Same shape as rag/reranker.py and rag/verifier.py.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass
from typing import Optional, Protocol, Sequence

from config import InjectionSettings

log = logging.getLogger("collabmind.injection")

WINDOW_OVERLAP_CHARS = 200
MAX_WINDOWS_PER_PASSAGE = 12


class Scorer(Protocol):
    def score(self, texts: Sequence[str]) -> Sequence[float]:
        """P(malicious) in [0, 1] for each text."""


class _DetectorScorer:
    def __init__(self, path: str):
        from ml.cross_encoder_train import load_predict   # optional dependency

        self._predict = load_predict(path, max_length=256, batch_size=16)

    def score(self, texts: Sequence[str]) -> Sequence[float]:
        return [1 / (1 + math.exp(-x)) for x in self._predict([(t, None) for t in texts])]


_scorer: Optional[Scorer] = None
_load_failed_for: Optional[str] = None


def set_scorer(scorer: Optional[Scorer]) -> None:
    """Test hook: install (or clear) the scorer."""
    global _scorer, _load_failed_for
    _scorer = scorer
    _load_failed_for = None


def _get_scorer(path: str) -> Optional[Scorer]:
    global _scorer, _load_failed_for
    if _scorer is not None:
        return _scorer
    if _load_failed_for == path:
        return None
    try:
        _scorer = _DetectorScorer(path)
    except Exception:  # noqa: BLE001 — missing dependency, bad path: all mean "no screening"
        _load_failed_for = path
        log.warning("injection detector %r could not be loaded; passages pass through unscreened", path, exc_info=True)
        return None
    return _scorer


def windows(text: str, size: int) -> list[str]:
    """Overlapping character windows covering `text` (at most MAX_WINDOWS_PER_PASSAGE, evenly spread if longer)."""
    if len(text) <= size:
        return [text]
    step = max(1, size - WINDOW_OVERLAP_CHARS)
    starts = list(range(0, max(1, len(text) - WINDOW_OVERLAP_CHARS), step))
    if len(starts) > MAX_WINDOWS_PER_PASSAGE:
        starts = [starts[round(i * (len(starts) - 1) / (MAX_WINDOWS_PER_PASSAGE - 1))] for i in range(MAX_WINDOWS_PER_PASSAGE)]
    return [text[s:s + size] for s in starts]


@dataclass
class ScreenResult:
    kept: list[dict]
    withheld: list[dict]          # passages dropped, each with `injection_score`
    latency_ms: int
    screened: bool                # False when disabled, unavailable or failed (nothing was removed)


async def screen_passages(cfg: InjectionSettings, passages: list[dict]) -> ScreenResult:
    """Split `passages` into kept and withheld. Never raises; on any problem everything is kept."""
    if not cfg.enabled or not passages:
        return ScreenResult(passages, [], 0, False)
    scorer = _get_scorer(cfg.model)
    if scorer is None:
        return ScreenResult(passages, [], 0, False)
    start = time.perf_counter()
    spans: list[tuple[int, str]] = [(i, w) for i, p in enumerate(passages) for w in windows(p["content"], cfg.window_chars)]
    try:
        probs = await asyncio.to_thread(scorer.score, [w for _, w in spans])   # CPU-bound: keep the event loop free
        if len(probs) != len(spans):
            raise ValueError("scorer returned the wrong number of scores")
    except Exception:  # noqa: BLE001
        log.warning("injection screening failed; passages left unscreened", exc_info=True)
        return ScreenResult(passages, [], 0, False)
    worst = [0.0] * len(passages)
    for (i, _), p in zip(spans, probs):
        worst[i] = max(worst[i], float(p))
    kept = [p for p, w in zip(passages, worst) if w < cfg.threshold]
    withheld = [{**p, "injection_score": round(w, 4)} for p, w in zip(passages, worst) if w >= cfg.threshold]
    return ScreenResult(kept, withheld, int((time.perf_counter() - start) * 1000), True)
