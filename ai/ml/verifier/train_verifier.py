"""
ml/verifier/train_verifier.py — fine-tune the claim-support verifier (run on a Kaggle/Colab GPU).

    python -m ml.verifier.train_verifier --train ml/data/out/verifier_train.jsonl \
        --dev ml/data/out/verifier_dev.jsonl --out models/verifier-v1

Model: DeBERTa-v3-small as a cross-encoder with ONE logit trained with binary cross-entropy
(sigmoid(logit) = probability the claim is SUPPORTED by the premise). Input is (premise, claim), truncated
to --max-length tokens. The best epoch is chosen by dev ROC-AUC. The held-out TEST file
(verifier_test.jsonl) is never passed here. The output directory is what VERIFIER_MODEL points at.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from ml.cross_encoder_train import train_cross_encoder
from ml.eval.classification import prf, roc_auc


def read_jsonl(path: str) -> list[dict]:
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    for n, r in enumerate(rows, start=1):
        if not {"premise", "hypothesis", "label"} <= r.keys() or r["label"] not in (0, 1):
            raise ValueError(f"{path}:{n}: need premise, hypothesis and a 0/1 label")
    if not rows:
        raise ValueError(f"{path} has no examples")
    return rows


def dev_auc(dev: list[dict]):
    pairs = [(r["premise"], r["hypothesis"]) for r in dev]
    labels = [r["label"] for r in dev]

    def metric(predict):
        logits = predict(pairs)
        auc = roc_auc(labels, logits)                       # how well P(supported) separates the two classes
        m = prf([1 - y for y in labels], [1 if x < 0 else 0 for x in logits])   # unsupported = positive, thr 0.5
        return auc, {"dev_auc": round(auc, 4), "dev_unsupported_f1@0.5": round(m["f1"], 4)}

    return metric


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--base", default="microsoft/deberta-v3-small")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max-length", type=int, default=384)
    ap.add_argument("--dev-size", type=int, default=3000, help="dev rows used for the per-epoch check")
    ap.add_argument("--supported-per-unsupported", type=float, default=0.0,
                    help="if > 0, keep all unsupported claims and this many supported ones per unsupported (smaller, faster run)")
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--no-fp16", action="store_true")
    args = ap.parse_args()

    train, dev = read_jsonl(args.train), read_jsonl(args.dev)
    if args.supported_per_unsupported:        # keep every unsupported claim, subsample the supported ones (CPU runs)
        unsup = [r for r in train if r["label"] == 0]
        sup = [r for r in train if r["label"] == 1]
        random.Random(args.seed).shuffle(sup)
        train = unsup + sup[: int(len(unsup) * args.supported_per_unsupported)]
        print(f"subsampled training set: {len(unsup)} unsupported + {len(train) - len(unsup)} supported", flush=True)
    random.Random(args.seed).shuffle(dev)
    dev = dev[: args.dev_size]
    train_cross_encoder(
        args.base, [(r["premise"], r["hypothesis"]) for r in train], [r["label"] for r in train], args.out,
        dev_auc(dev), epochs=args.epochs, batch_size=args.batch_size, lr=args.lr,
        max_length=args.max_length, seed=args.seed, fp16=not args.no_fp16)


if __name__ == "__main__":
    main()
