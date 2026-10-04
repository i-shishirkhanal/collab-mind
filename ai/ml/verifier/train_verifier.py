"""
ml/verifier/train_verifier.py — fine-tune the claim-support verifier (run on a Kaggle/Colab GPU).

    python -m ml.verifier.train_verifier --train ml/data/out/verifier_train.jsonl \
        --dev ml/data/out/verifier_dev.jsonl --out models/verifier-v1

Model: DeBERTa-v3-small as a cross-encoder with ONE logit trained with binary cross-entropy
(sigmoid(logit) = probability the claim is SUPPORTED by the premise). Input is (premise, claim), truncated
to --max-length tokens. The held-out TEST file (verifier_test.jsonl) is never passed here.
The output directory is what VERIFIER_MODEL points at.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path


def read_jsonl(path: str) -> list[dict]:
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    for n, r in enumerate(rows, start=1):
        if not {"premise", "hypothesis", "label"} <= r.keys() or r["label"] not in (0, 1):
            raise ValueError(f"{path}:{n}: need premise, hypothesis and a 0/1 label")
    if not rows:
        raise ValueError(f"{path} has no examples")
    return rows


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
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args()

    from sentence_transformers import InputExample
    from sentence_transformers.cross_encoder import CrossEncoder
    from sentence_transformers.cross_encoder.evaluation import CEBinaryClassificationEvaluator
    from torch.utils.data import DataLoader

    random.seed(args.seed)
    train, dev = read_jsonl(args.train), read_jsonl(args.dev)
    random.shuffle(dev)
    dev = dev[: args.dev_size]
    evaluator = CEBinaryClassificationEvaluator([[r["premise"], r["hypothesis"]] for r in dev],
                                                [r["label"] for r in dev], name="dev")
    model = CrossEncoder(args.base, num_labels=1, max_length=args.max_length)
    loader = DataLoader([InputExample(texts=[r["premise"], r["hypothesis"]], label=float(r["label"])) for r in train],
                        shuffle=True, batch_size=args.batch_size)
    model.fit(train_dataloader=loader, evaluator=evaluator, epochs=args.epochs,
              warmup_steps=max(1, int(0.1 * len(loader))), optimizer_params={"lr": args.lr},
              output_path=args.out, save_best_model=True)
    print(f"saved best model to {args.out}")


if __name__ == "__main__":
    main()
