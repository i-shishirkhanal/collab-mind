"""
ml/injection/train_injection.py — fine-tune the prompt-injection detector (runs on CPU or a GPU).

    python -m ml.injection.train_injection --train ml/data/out/injection_train.jsonl \
        --dev ml/data/out/injection_dev.jsonl --out models/injection-v1

Model: DistilBERT (66M parameters, Apache-2.0) with ONE logit and binary cross-entropy: sigmoid(logit) = probability the
text contains an instruction aimed at the model. Chosen small on purpose: it scans every uploaded chunk, so it has to run
on CPU. The best epoch is chosen by dev F1; the held-out test files are never passed here.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from ml.cross_encoder_train import train_cross_encoder
from ml.eval.classification import prf, roc_auc


def read_jsonl(path: str) -> list[dict]:
    rows = [json.loads(x) for x in Path(path).read_text(encoding="utf-8").splitlines() if x.strip()]
    if not rows or any(not {"text", "label"} <= r.keys() for r in rows):
        raise ValueError(f"{path}: need non-empty rows with text and label")
    return rows


def dev_f1(dev: list[dict]):
    texts = [(r["text"], None) for r in dev]
    labels = [r["label"] for r in dev]

    def metric(predict):
        logits = predict(texts)
        m = prf(labels, [1 if x > 0 else 0 for x in logits])
        auc = roc_auc(labels, logits) if 0 < sum(labels) < len(labels) else float("nan")
        return m["f1"], {"dev_f1@0.5": round(m["f1"], 4), "dev_precision": round(m["precision"], 4),
                         "dev_recall": round(m["recall"], 4), "dev_auc": round(auc, 4)}

    return metric


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--base", default="distilbert/distilbert-base-uncased")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--max-length", type=int, default=256)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--no-fp16", action="store_true")
    args = ap.parse_args()

    train, dev = read_jsonl(args.train), read_jsonl(args.dev)
    random.Random(args.seed).shuffle(train)
    train_cross_encoder(args.base, [(r["text"], None) for r in train], [r["label"] for r in train], args.out,
                        dev_f1(dev), epochs=args.epochs, batch_size=args.batch_size, lr=args.lr,
                        max_length=args.max_length, seed=args.seed, fp16=not args.no_fp16)


if __name__ == "__main__":
    main()
