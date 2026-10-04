"""
ml/verifier/sentences.py — claim splitting and premise selection shared by training, evaluation and the
service (rag/verifier.py), so the model sees the same kind of input everywhere.

A "claim" is one sentence of an answer with citation markers like [1] removed. The "premise" for a claim is
the few passage windows that best overlap it lexically (cross-encoders read ~512 tokens, so a long context
cannot be fed whole).
"""

from __future__ import annotations

import re

_CITE = re.compile(r"\s*\[\d+(?:\s*,\s*\d+)*\]")
_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])|\n+")
_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset("a an and are as at be by for from has have in is it its of on or that the to was were with".split())
MIN_CLAIM_CHARS = 20
MAX_PREMISE_CHARS = 1400


def strip_citations(text: str) -> str:
    return _CITE.sub("", text)


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SPLIT.split(text) if s and s.strip()]


def sentence_spans(text: str) -> list[tuple[int, int, str]]:
    """(start, end, sentence) with character offsets into `text`; used to map span-level labels to sentences."""
    spans, pos = [], 0
    for m in list(_SPLIT.finditer(text)) + [None]:
        end = m.start() if m else len(text)
        seg = text[pos:end]
        if seg.strip():
            lead = len(seg) - len(seg.lstrip())
            spans.append((pos + lead, pos + len(seg.rstrip()), seg.strip()))
        pos = m.end() if m else len(text)
    return spans


def split_claims(answer: str) -> list[str]:
    """Checkable sentences of an answer: citations removed, headings/fragments dropped."""
    claims = []
    for s in split_sentences(strip_citations(answer)):
        s = s.lstrip("-*•# ").strip()
        if len(s) >= MIN_CLAIM_CHARS and len(_WORD.findall(s.lower())) >= 4:
            claims.append(s)
    return claims


def _terms(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP}


def select_premise(claim: str, context: str, max_chars: int = MAX_PREMISE_CHARS, window: int = 2) -> str:
    """The context windows (`window` consecutive sentences) that overlap the claim most, in original order."""
    if len(context) <= max_chars:
        return context
    sents = split_sentences(context) or [context]
    wins = [(i, " ".join(sents[i:i + window])) for i in range(0, len(sents), max(1, window - 1))]
    want = _terms(claim)
    ranked = sorted(wins, key=lambda w: len(want & _terms(w[1])) / (1 + len(_terms(w[1])) ** 0.5), reverse=True)
    chosen, used = [], 0
    for i, text in ranked:
        if used + len(text) > max_chars and chosen:
            break
        chosen.append((i, text[:max_chars]))
        used += len(text)
    return " ".join(t for _, t in sorted(chosen))
