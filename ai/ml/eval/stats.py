"""
ml/eval/stats.py — bootstrap confidence intervals and paired significance tests for the results tables.

SciFact's test set has ~300 queries, so differences of a point or two are noise. Every table reports a 95%
percentile-bootstrap interval, and system comparisons use a PAIRED bootstrap over the same queries.
Pure Python, seeded, deterministic.
"""

from __future__ import annotations

import random
from typing import Callable, Sequence


def _resample(n: int, rng: random.Random) -> list[int]:
    return [rng.randrange(n) for _ in range(n)]


def bootstrap_ci(values: Sequence[float], *, n_boot: int = 2000, alpha: float = 0.05, seed: int = 13) -> tuple[float, float, float]:
    """(mean, lo, hi): percentile bootstrap interval of the mean of per-query values."""
    if not values:
        raise ValueError("no values")
    rng = random.Random(seed)
    means = sorted(sum(values[i] for i in _resample(len(values), rng)) / len(values) for _ in range(n_boot))
    return sum(values) / len(values), means[int(n_boot * alpha / 2)], means[int(n_boot * (1 - alpha / 2)) - 1]


def paired_bootstrap(a: Sequence[float], b: Sequence[float], *, n_boot: int = 2000, alpha: float = 0.05,
                     seed: int = 13) -> dict[str, float]:
    """Paired comparison of per-query scores of systems A and B on the SAME queries.

    Returns the mean difference (a - b), its bootstrap interval, and a two-sided p-value (share of resamples whose
    sign disagrees with the observed difference, doubled). The difference is only worth claiming when the
    interval excludes 0."""
    if len(a) != len(b) or not a:
        raise ValueError("need equal-length, non-empty score lists")
    diffs = [x - y for x, y in zip(a, b)]
    rng = random.Random(seed)
    means = sorted(sum(diffs[i] for i in _resample(len(diffs), rng)) / len(diffs) for _ in range(n_boot))
    observed = sum(diffs) / len(diffs)
    opposite = sum(1 for m in means if (m <= 0 if observed > 0 else m >= 0)) / n_boot
    return {"diff": observed, "lo": means[int(n_boot * alpha / 2)], "hi": means[int(n_boot * (1 - alpha / 2)) - 1],
            "p": min(1.0, 2 * opposite)}


def bootstrap_stat_ci(n: int, stat: Callable[[list[int]], float], *, n_boot: int = 1000, alpha: float = 0.05,
                      seed: int = 13) -> tuple[float, float, float]:
    """(value, lo, hi) of any statistic computed from resampled row indices (e.g. F1 of the unsupported class)."""
    rng = random.Random(seed)
    vals = sorted(stat(_resample(n, rng)) for _ in range(n_boot))
    return stat(list(range(n))), vals[int(n_boot * alpha / 2)], vals[int(n_boot * (1 - alpha / 2)) - 1]
