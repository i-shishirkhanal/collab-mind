"""
ml/injection/heuristic.py — the keyword/regex baseline the learned detector must beat.

The obvious defence a student platform would write first: flag text containing well-known override phrases. It is
shared by the evaluation (as the baseline) and is deliberately simple; its failures (paraphrase, other languages,
roleplay jailbreaks) are the argument for a learned model.
"""

from __future__ import annotations

import re

PATTERNS = [re.compile(p, re.I) for p in (
    r"ignore (all |any |the )?(previous|prior|above|earlier|preceding) (instructions|prompts?|rules|messages)",
    r"disregard (all |any |the )?(previous|prior|above|earlier) ",
    r"forget (all |everything|your) (previous |prior )?(instructions|rules|training)",
    r"(reveal|show|print|repeat|output) (me )?(your|the) (system |hidden |initial )?(prompt|instructions)",
    r"you are now (in )?(dan|developer mode|an? unrestricted)",
    r"\bjailbreak\b",
    r"do anything now",
    r"pretend (that )?you (have no|are not bound|are free)",
    r"(without|ignoring) (any )?(restrictions|filters|guidelines|safety)",
    r"new instructions?:",
    r"system override",
    r"<<\s*(system|admin)",
)]


def score(text: str) -> float:
    """1.0 if any known override phrase appears, else 0.0 (a hard rule has no calibrated probability)."""
    return 1.0 if any(p.search(text) for p in PATTERNS) else 0.0
