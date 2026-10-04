"""
ml/data/scifact.py — the BEIR SciFact retrieval benchmark (scientific claims -> abstracts).

BEIR protocol: queries in the qrels `train` split are for tuning, queries in `test` are the held-out
test set and are never used for training. Source: BeIR/scifact (CC BY-NC 4.0).
"""

from __future__ import annotations

from ml.data.hf_rows import iter_rows


def load_corpus() -> dict[str, str]:
    """doc_id -> 'title. text'."""
    return {r["_id"]: f'{r["title"]}. {r["text"]}'.strip(". ")
            for r in iter_rows("BeIR/scifact", "corpus", "corpus")}


def load_queries() -> dict[str, str]:
    return {r["_id"]: r["text"] for r in iter_rows("BeIR/scifact", "queries", "queries")}


def load_qrels(split: str) -> dict[str, set[str]]:
    """query_id -> relevant doc ids (score > 0). `split` is 'train' or 'test'."""
    out: dict[str, set[str]] = {}
    for r in iter_rows("BeIR/scifact-qrels", "default", split):
        if r["score"] > 0:
            out.setdefault(str(r["query-id"]), set()).add(str(r["corpus-id"]))
    return out
