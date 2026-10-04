"""
ml/train_reranker.py — fine-tune a cross-encoder reranker (run on a Kaggle/Colab GPU, not in the service).

Input: a JSONL file with one example per line:
    {"query": "...", "passage": "...", "label": 1}      # 1 = relevant, 0 = hard negative
Hard negatives come from the CURRENT first-stage retriever (ml/data/make_reranker_data.py mines them with BM25).

    pip install -r requirements-ml.txt
    python -m ml.train_reranker --train ml/data/out/train.jsonl --dev ml/data/out/dev.jsonl \
        --base cross-encoder/ms-marco-MiniLM-L-6-v2 --out models/reranker-v1

Loss: binary cross-entropy on one relevance logit per (query, passage). The best epoch is chosen by
dev MRR@10 (queries are ranked among their own positives and negatives). The held-out TEST queries are
never passed here. The output directory is what RERANKER_MODEL points at.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ml.cross_encoder_train import train_cross_encoder
from ml.eval.metrics import mrr_at_k


def read_jsonl(path: str) -> list[dict]:
    rows = []
    for n, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not {"query", "passage", "label"} <= row.keys() or row["label"] not in (0, 1):
            raise ValueError(f"{path}:{n}: need query, passage and a 0/1 label")
        rows.append(row)
    if not rows:
        raise ValueError(f"{path} has no examples")
    return rows


def dev_mrr(dev: list[dict]):
    """MRR@10 of ranking each dev query's candidates by the model's score."""
    groups: dict[str, list[dict]] = {}
    for r in dev:
        groups.setdefault(r["query"], []).append(r)
    groups = {q: g for q, g in groups.items() if any(r["label"] for r in g) and any(not r["label"] for r in g)}
    flat = [(q, r["passage"]) for q, g in groups.items() for r in g]

    def metric(predict):
        scores = iter(predict(flat))
        total = 0.0
        for q, g in groups.items():
            scored = [(next(scores), i) for i in range(len(g))]
            ranked = [i for _, i in sorted(scored, reverse=True)]
            total += mrr_at_k(ranked, {i for i, r in enumerate(g) if r["label"]}, 10)
        mrr = total / max(1, len(groups))
        return mrr, {"dev_mrr@10": round(mrr, 4), "dev_queries": len(groups)}

    return metric


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--base", default="cross-encoder/ms-marco-MiniLM-L-6-v2")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max-length", type=int, default=384)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--no-fp16", action="store_true")
    args = ap.parse_args()

    train, dev = read_jsonl(args.train), read_jsonl(args.dev)
    train_cross_encoder(
        args.base, [(r["query"], r["passage"]) for r in train], [r["label"] for r in train], args.out,
        dev_mrr(dev), epochs=args.epochs, batch_size=args.batch_size, lr=args.lr,
        max_length=args.max_length, seed=args.seed, fp16=not args.no_fp16)


if __name__ == "__main__":
    main()
