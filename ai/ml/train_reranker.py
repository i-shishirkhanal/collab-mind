"""
ml/train_reranker.py — fine-tune a cross-encoder reranker (run on Colab/GPU, not in the service).

Input: a JSONL file with one example per line:
    {"query": "...", "passage": "...", "label": 1}      # 1 = relevant, 0 = hard negative
Hard negatives should come from the CURRENT retriever (chunks it ranked high that were marked not
relevant), plus public data (MS MARCO / SQuAD) for the base model.

    pip install -r requirements-ml.txt
    python -m ml.train_reranker --train data/train.jsonl --dev data/dev.jsonl \
        --base cross-encoder/ms-marco-MiniLM-L-6-v2 --out models/reranker-v1

The held-out TEST set must be fixed before any tuning and must never be passed here.
The output directory is what RERANKER_MODEL points at.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path


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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--base", default="cross-encoder/ms-marco-MiniLM-L-6-v2")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args()

    from sentence_transformers import InputExample
    from sentence_transformers.cross_encoder import CrossEncoder
    from sentence_transformers.cross_encoder.evaluation import CERerankingEvaluator
    from torch.utils.data import DataLoader

    random.seed(args.seed)
    train = read_jsonl(args.train)
    dev = read_jsonl(args.dev)
    random.shuffle(train)

    # Dev: group by query for a ranking metric (MRR@10) instead of a plain accuracy.
    grouped: dict[str, dict] = {}
    for r in dev:
        g = grouped.setdefault(r["query"], {"query": r["query"], "positive": [], "negative": []})
        g["positive" if r["label"] == 1 else "negative"].append(r["passage"])
    samples = [g for g in grouped.values() if g["positive"] and g["negative"]]
    evaluator = CERerankingEvaluator(samples, name="dev")

    model = CrossEncoder(args.base, num_labels=1, max_length=512)   # one logit + BCE-with-logits loss
    loader = DataLoader([InputExample(texts=[r["query"], r["passage"]], label=float(r["label"])) for r in train],
                        shuffle=True, batch_size=args.batch_size)
    model.fit(train_dataloader=loader, evaluator=evaluator, epochs=args.epochs,
              warmup_steps=max(1, int(0.1 * len(loader))), optimizer_params={"lr": args.lr},
              output_path=args.out, save_best_model=True)
    print(f"saved best model to {args.out}")


if __name__ == "__main__":
    main()
