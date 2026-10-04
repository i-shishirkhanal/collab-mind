"""
ml/eval/classification.py — binary-classification metrics for the verifier and the calibration model.

Pure Python (no numpy/sklearn) so tests run anywhere. Convention: label 1 = positive class; `scores` are
the model's probability (or any monotone score) of the positive class.
"""

from __future__ import annotations

from typing import Sequence


def confusion(labels: Sequence[int], preds: Sequence[int]) -> dict[str, int]:
    tp = sum(1 for y, p in zip(labels, preds) if y == 1 and p == 1)
    fp = sum(1 for y, p in zip(labels, preds) if y == 0 and p == 1)
    fn = sum(1 for y, p in zip(labels, preds) if y == 1 and p == 0)
    tn = sum(1 for y, p in zip(labels, preds) if y == 0 and p == 0)
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn}


def prf(labels: Sequence[int], preds: Sequence[int]) -> dict[str, float]:
    c = confusion(labels, preds)
    precision = c["tp"] / (c["tp"] + c["fp"]) if c["tp"] + c["fp"] else 0.0
    recall = c["tp"] / (c["tp"] + c["fn"]) if c["tp"] + c["fn"] else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1, **{k: float(v) for k, v in c.items()}}


def roc_auc(labels: Sequence[int], scores: Sequence[float]) -> float:
    """Area under the ROC curve via the rank-sum (Mann-Whitney) formula; ties get average rank."""
    pos = sum(labels)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        raise ValueError("AUC needs both classes")
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    rank_sum = sum(r for r, y in zip(ranks, labels) if y == 1)
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


def best_threshold(labels: Sequence[int], scores: Sequence[float]) -> float:
    """Threshold maximising F1 (pick it on a DEV set, then apply it unchanged to the test set)."""
    best_t, best_f1 = 0.5, -1.0
    for t in sorted(set(scores)):
        f1 = prf(labels, [1 if s >= t else 0 for s in scores])["f1"]
        if f1 > best_f1:
            best_t, best_f1 = t, f1
    return best_t


def ece(labels: Sequence[int], probs: Sequence[float], bins: int = 10) -> float:
    """Expected calibration error of positive-class probabilities (equal-width bins)."""
    n = len(labels)
    total = 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        idx = [i for i, p in enumerate(probs) if (lo <= p < hi) or (b == bins - 1 and p == 1.0)]
        if idx:
            conf = sum(probs[i] for i in idx) / len(idx)
            acc = sum(labels[i] for i in idx) / len(idx)
            total += len(idx) / n * abs(acc - conf)
    return total
