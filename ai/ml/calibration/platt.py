"""
ml/calibration/platt.py — Platt scaling: map a raw score to a calibrated probability, fit on a DEV set only.

    p_calibrated = sigmoid(a * logit(p_raw) + b)

Two parameters, fitted by Newton's method on the logistic log-loss (pure Python, deterministic). Calibration matters
here because the UI shows "faithfulness 0.91" and a student will read it as a probability; a classifier trained with a
hinge-like threshold or on resampled classes is usually over- or under-confident, which ECE and the reliability table
make visible.
"""

from __future__ import annotations

import math
from typing import Sequence

EPS = 1e-6


def logit(p: float) -> float:
    p = min(1 - EPS, max(EPS, p))
    return math.log(p / (1 - p))


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x)) if x >= 0 else math.exp(x) / (1 + math.exp(x))


def fit(probs: Sequence[float], labels: Sequence[int], *, iters: int = 50, l2: float = 1e-4) -> tuple[float, float]:
    """(a, b) minimising log-loss of sigmoid(a*logit(p)+b) against 0/1 labels (tiny L2 on a-1 keeps it stable)."""
    if not probs or len(probs) != len(labels) or len(set(labels)) < 2:
        raise ValueError("need matching, non-empty probs/labels containing both classes")
    xs = [logit(p) for p in probs]

    def loss(a: float, b: float) -> float:
        total = 0.0
        for x, y in zip(xs, labels):
            z = a * x + b
            total += max(z, 0) - z * y + math.log1p(math.exp(-abs(z)))      # stable log-loss of sigmoid(z) vs y
        return total + 0.5 * l2 * (a - 1) ** 2      # sum-scale, matching the gradient and Hessian below

    a, b = 1.0, 0.0
    for _ in range(iters):
        ga = gb = 0.0
        haa = hab = hbb = 0.0
        for x, y in zip(xs, labels):
            p = sigmoid(a * x + b)
            r = p - y
            w = max(p * (1 - p), 1e-9)
            ga += r * x
            gb += r
            haa += w * x * x
            hab += w * x
            hbb += w
        ga += l2 * (a - 1)
        haa += l2
        det = haa * hbb - hab * hab
        if abs(det) < 1e-12:
            break
        da = (hbb * ga - hab * gb) / det
        db = (haa * gb - hab * ga) / det
        step, current = 1.0, loss(a, b)
        while step > 1e-6 and loss(a - step * da, b - step * db) > current:   # damped Newton: never step uphill
            step /= 2
        if step <= 1e-6:
            break
        a, b = a - step * da, b - step * db
        if abs(step * da) + abs(step * db) < 1e-9:
            break
    return a, b


def apply(prob: float, a: float, b: float) -> float:
    return sigmoid(a * logit(prob) + b)


def brier(probs: Sequence[float], labels: Sequence[int]) -> float:
    return sum((p - y) ** 2 for p, y in zip(probs, labels)) / len(probs)


def reliability(probs: Sequence[float], labels: Sequence[int], bins: int = 10) -> list[dict]:
    """Per-bin mean confidence vs observed frequency, for the reliability diagram / table."""
    out = []
    for k in range(bins):
        lo, hi = k / bins, (k + 1) / bins
        idx = [i for i, p in enumerate(probs) if lo <= p < hi or (k == bins - 1 and p == 1.0)]
        if idx:
            out.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": len(idx),
                        "confidence": sum(probs[i] for i in idx) / len(idx),
                        "observed": sum(labels[i] for i in idx) / len(idx)})
    return out
