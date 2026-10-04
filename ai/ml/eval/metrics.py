"""
ml/eval/metrics.py — retrieval metrics for the ablation table (Recall@k, MRR@10, NDCG@10).

Pure functions over one query's ranked result list. `ranked` is a list of chunk keys in rank order;
`relevant` is the set of keys a human marked relevant for that query (binary relevance).
"""

from __future__ import annotations

import math
from typing import Hashable, Iterable, Sequence


def recall_at_k(ranked: Sequence[Hashable], relevant: set, k: int) -> float:
    """Share of the relevant chunks found in the top k."""
    if not relevant:
        raise ValueError("a query needs at least one relevant chunk")
    return len(set(ranked[:k]) & relevant) / len(relevant)


def mrr_at_k(ranked: Sequence[Hashable], relevant: set, k: int = 10) -> float:
    """1 / rank of the first relevant chunk in the top k, else 0."""
    for i, key in enumerate(ranked[:k], start=1):
        if key in relevant:
            return 1.0 / i
    return 0.0


def ndcg_at_k(ranked: Sequence[Hashable], relevant: set, k: int = 10) -> float:
    """Binary-relevance NDCG: DCG of the ranking over the DCG of a perfect ranking."""
    if not relevant:
        raise ValueError("a query needs at least one relevant chunk")
    dcg = sum(1.0 / math.log2(i + 1) for i, key in enumerate(ranked[:k], start=1) if key in relevant)
    ideal = sum(1.0 / math.log2(i + 1) for i in range(1, min(len(relevant), k) + 1))
    return dcg / ideal


def evaluate(runs: Iterable[tuple[Sequence[Hashable], set]], ks: Sequence[int] = (1, 5, 10)) -> dict[str, float]:
    """Mean of every metric over queries: [(ranked, relevant), ...]."""
    runs = list(runs)
    if not runs:
        raise ValueError("no queries to evaluate")
    out: dict[str, float] = {}
    for k in ks:
        out[f"recall@{k}"] = sum(recall_at_k(r, rel, k) for r, rel in runs) / len(runs)
    out["mrr@10"] = sum(mrr_at_k(r, rel, 10) for r, rel in runs) / len(runs)
    out["ndcg@10"] = sum(ndcg_at_k(r, rel, 10) for r, rel in runs) / len(runs)
    out["queries"] = float(len(runs))
    return out
