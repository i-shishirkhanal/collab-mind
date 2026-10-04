"""
ml/eval/bm25.py — a small dependency-free BM25 (Okapi) index.

Used as the lexical first stage in the retrieval ablation and to mine hard negatives for reranker
training. Mirrors the keyword half of the platform's hybrid retrieval closely enough for a benchmark.
"""

from __future__ import annotations

import math
import re
from collections import Counter

_TOKEN = re.compile(r"[a-z0-9]+")
_STOP = frozenset("a an and are as at be by for from has have in is it its of on or that the to was were with".split())


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN.findall(text.lower()) if t not in _STOP]


class BM25:
    def __init__(self, docs: dict[str, str], k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self.ids = list(docs)
        self.tf = [Counter(tokenize(docs[i])) for i in self.ids]
        self.len = [sum(c.values()) for c in self.tf]
        self.avg = sum(self.len) / max(1, len(self.len))
        df: Counter = Counter()
        for c in self.tf:
            df.update(c.keys())
        n = len(self.ids)
        self.idf = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}
        self.postings: dict[str, list[int]] = {}
        for pos, c in enumerate(self.tf):
            for t in c:
                self.postings.setdefault(t, []).append(pos)

    def search(self, query: str, k: int = 100) -> list[tuple[str, float]]:
        scores: dict[int, float] = {}
        for t in set(tokenize(query)):
            idf = self.idf.get(t)
            if idf is None:
                continue
            for pos in self.postings[t]:
                f = self.tf[pos][t]
                norm = f + self.k1 * (1 - self.b + self.b * self.len[pos] / self.avg)
                scores[pos] = scores.get(pos, 0.0) + idf * f * (self.k1 + 1) / norm
        top = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:k]
        return [(self.ids[p], s) for p, s in top]
