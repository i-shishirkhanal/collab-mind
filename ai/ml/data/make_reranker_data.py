"""
ml/data/make_reranker_data.py — build reranker training data from BEIR SciFact.

    python -m ml.data.make_reranker_data

Writes ml/data/out/{train,dev}.jsonl with {"query", "passage", "label"} rows (the format
ml/train_reranker.py reads). Positives come from the qrels `train` split; hard negatives are the
highest-ranked BM25 documents that are NOT marked relevant, which is exactly the kind of near-miss a
first-stage retriever returns and a reranker must learn to push down.

The qrels `test` split is never touched here: it is the held-out test set for ml/eval/run_retrieval_eval.py.
Queries (not rows) are split into train/dev, so no query appears in both.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from ml.data import scifact
from ml.eval.bm25 import BM25

OUT = Path(__file__).parent / "out"


def build(neg_per_pos: int, pool: int, dev_share: float, seed: int) -> tuple[list[dict], list[dict]]:
    rng = random.Random(seed)
    corpus, queries, qrels = scifact.load_corpus(), scifact.load_queries(), scifact.load_qrels("train")
    index = BM25(corpus)
    qids = sorted(qrels)
    rng.shuffle(qids)
    n_dev = max(1, int(len(qids) * dev_share))
    dev_ids = set(qids[:n_dev])

    train, dev = [], []
    for qid in qids:
        relevant = qrels[qid]
        ranked = [d for d, _ in index.search(queries[qid], k=pool) if d not in relevant]
        rows = [{"query": queries[qid], "passage": corpus[d], "label": 1} for d in relevant if d in corpus]
        negatives = ranked[: neg_per_pos * max(1, len(relevant)) * 2]          # hardest first
        rng.shuffle(negatives)
        rows += [{"query": queries[qid], "passage": corpus[d], "label": 0}
                 for d in negatives[: neg_per_pos * max(1, len(relevant))]]
        (dev if qid in dev_ids else train).extend(rows)
    return train, dev


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--neg-per-pos", type=int, default=4)
    ap.add_argument("--pool", type=int, default=30, help="BM25 depth negatives are drawn from")
    ap.add_argument("--dev-share", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args()

    train, dev = build(args.neg_per_pos, args.pool, args.dev_share, args.seed)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, rows in (("train", train), ("dev", dev)):
        (OUT / f"{name}.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
        pos = sum(r["label"] for r in rows)
        print(f"{name}: {len(rows)} rows ({pos} positive, {len(rows) - pos} hard negative) -> {OUT / (name + '.jsonl')}")


if __name__ == "__main__":
    main()
