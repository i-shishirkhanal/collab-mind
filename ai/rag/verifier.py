"""
rag/verifier.py — optional faithfulness check of a generated answer.

The answer is split into claims (sentences). Each claim is scored by a fine-tuned cross-encoder
(ml/verifier/train_verifier.py) against the passage(s) it cites, or against the best-matching windows of all
retrieved passages if it cites none. The result is a faithfulness score (share of claims judged supported) and
the list of claims judged unsupported, so the UI can flag them.

OFF by default (VERIFIER_ENABLED) and it never makes a request fail: if the model cannot load or scoring
raises, no faithfulness is attached and the problem is logged. `torch`/`sentence-transformers` are optional
dependencies (requirements-ml.txt) imported lazily. Same shape as rag/reranker.py.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from dataclasses import dataclass, field
from typing import Optional, Protocol, Sequence

from config import VerifierSettings
from ml.verifier.sentences import MIN_CLAIM_CHARS, select_premise, split_sentences, strip_citations

log = logging.getLogger("collabmind.verifier")

_MARKERS = re.compile(r"\[(\d+(?:\s*[,;]\s*\d+)*)\]")
_WORD = re.compile(r"[A-Za-z0-9]+")


class Scorer(Protocol):
    def score(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]:
        """P(supported) in [0, 1] for each (premise, claim)."""


class _CrossEncoderScorer:
    def __init__(self, model_name: str):
        from sentence_transformers import CrossEncoder   # optional dependency

        self._model = CrossEncoder(model_name, max_length=384)

    def score(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]:
        raw = self._model.predict(list(pairs), batch_size=16, show_progress_bar=False)
        return [1 / (1 + math.exp(-float(x))) for x in raw]


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
        return None
    try:
        _scorer = _CrossEncoderScorer(model_name)
    except Exception:  # noqa: BLE001 — missing dependency, bad path: all mean "no verification"
        _load_failed_for = model_name
        log.warning("verifier %r could not be loaded; answers will not be scored", model_name, exc_info=True)
        return None
    return _scorer


@dataclass
class ClaimVerdict:
    text: str
    supported_probability: float
    supported: bool
    cited: list[int] = field(default_factory=list)


@dataclass
class Faithfulness:
    score: float                      # share of checked claims judged supported, 0..1
    claims_checked: int
    unsupported: list[ClaimVerdict]
    latency_ms: int


def claims_with_citations(answer: str, max_claims: int) -> list[tuple[str, list[int]]]:
    """Checkable sentences of an answer with the passage numbers each one cites."""
    out: list[tuple[str, list[int]]] = []
    for sentence in split_sentences(answer):
        cited = sorted({int(n) for g in _MARKERS.findall(sentence) for n in re.split(r"[,;]", g)})
        text = strip_citations(sentence).lstrip("-*•# ").strip()
        if len(text) >= MIN_CLAIM_CHARS and len(_WORD.findall(text)) >= 4:
            out.append((text, cited))
        if len(out) >= max_claims:
            break
    return out


def _calibrate(p: float, a: float, b: float) -> float:
    """Platt scaling sigmoid(a*logit(p)+b); the identity (a=1, b=0) is the default. Fitted by ml/calibration/."""
    if (a, b) == (1.0, 0.0):
        return p
    p = min(1 - 1e-6, max(1e-6, p))
    return 1 / (1 + math.exp(-(a * math.log(p / (1 - p)) + b)))


def _premise(claim: str, cited: list[int], passages: list[dict]) -> str:
    texts = [passages[n - 1]["content"] for n in cited if 1 <= n <= len(passages)]
    if not texts:
        texts = [p["content"] for p in passages]
    return select_premise(claim, "\n".join(texts))


async def verify_answer(cfg: VerifierSettings, answer: str, passages: list[dict]) -> Optional[Faithfulness]:
    """Faithfulness of `answer` to `passages`, or None when disabled, nothing to check, or on any problem."""
    if not cfg.enabled or not passages:
        return None
    claims = claims_with_citations(answer, cfg.max_claims)
    if not claims:
        return None
    scorer = _get_scorer(cfg.model)
    if scorer is None:
        return None
    start = time.perf_counter()
    pairs = [(_premise(text, cited, passages), text) for text, cited in claims]
    try:
        probs = await asyncio.to_thread(scorer.score, pairs)   # CPU-bound: keep the event loop free
        if len(probs) != len(claims):
            raise ValueError("scorer returned the wrong number of scores")
    except Exception:  # noqa: BLE001
        log.warning("verification failed; answer left unscored", exc_info=True)
        return None
    probs = [_calibrate(float(p), cfg.calib_a, cfg.calib_b) for p in probs]
    verdicts = [ClaimVerdict(text, float(p), float(p) >= cfg.threshold, cited)
                for (text, cited), p in zip(claims, probs)]
    unsupported = [v for v in verdicts if not v.supported]
    return Faithfulness(score=round(1 - len(unsupported) / len(verdicts), 4), claims_checked=len(verdicts),
                        unsupported=unsupported, latency_ms=int((time.perf_counter() - start) * 1000))
