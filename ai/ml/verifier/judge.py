"""
ml/verifier/judge.py — the "LLM judges the claim" baseline, run locally and saved for the evaluation to reuse.

    python -m ml.verifier.judge --sample 600

Why a separate step: the OpenRouter key must never go to Kaggle, and the verifier evaluation runs there. This script
spends the (capped, cheap) LLM calls locally on a FIXED stratified subset of the held-out test claims and writes
ml/data/out/judge_preds.json; ml.verifier.evaluate --judge-preds then scores every system on exactly those claims.

Fairness rules (frozen here, not tuned): one prompt (JUDGE_SYSTEM), temperature 0, one call per claim, the same premise
text the fine-tuned model sees, no few-shot examples, the same test split. The subset is stratified (default 33%
unsupported) so recall and precision are measurable; it is therefore NOT comparable with the full-test base rate.
A hash of every claim is stored so a mismatch between this file and the evaluation's test split is detected, not ignored.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import time
from pathlib import Path

OUT = Path(__file__).parent.parent / "data" / "out"
JUDGE_SYSTEM = ("You check whether a CLAIM is fully supported by a PASSAGE. Answer with exactly one word: "
                "SUPPORTED if the passage states or clearly implies the claim, otherwise UNSUPPORTED.")


def claim_hash(row: dict) -> str:
    return hashlib.md5((row["premise"] + "\x00" + row["hypothesis"]).encode("utf-8")).hexdigest()[:12]


def select_subset(unsup: list[int], n: int, pos_share: float, seed: int) -> list[int]:
    """Indices of a stratified subset: round(n * pos_share) unsupported claims, the rest supported. Deterministic."""
    rng = random.Random(seed)
    pos = [i for i, y in enumerate(unsup) if y == 1]
    neg = [i for i, y in enumerate(unsup) if y == 0]
    rng.shuffle(pos)
    rng.shuffle(neg)
    k = round(n * pos_share)
    return sorted(pos[:k] + neg[: n - k])


def judge_claims(rows: list[dict]) -> tuple[list[int], float]:
    """1 = judged UNSUPPORTED. Calls the capped LLM client once per claim."""
    from ml import llm

    preds, t0 = [], time.perf_counter()
    for r in rows:
        ans = llm.chat(f"PASSAGE:\n{r['premise']}\n\nCLAIM:\n{r['hypothesis']}", system=JUDGE_SYSTEM, max_tokens=4, temperature=0)
        preds.append(0 if re.match(r"\s*SUPPORTED", ans, re.I) else 1)
    return preds, 1000 * (time.perf_counter() - t0) / max(1, len(rows))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=600)
    ap.add_argument("--pos-share", type=float, default=0.33)
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args()

    from ml import llm

    test = [json.loads(x) for x in (OUT / "verifier_test.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    idx = select_subset([1 - r["label"] for r in test], args.sample, args.pos_share, args.seed)
    preds, ms = judge_claims([test[i] for i in idx])
    (OUT / "judge_preds.json").write_text(json.dumps({
        "idx": idx, "hashes": [claim_hash(test[i]) for i in idx], "preds": preds, "ms": ms,
        "model": llm.MODEL, "prompt": JUDGE_SYSTEM, "pos_share": args.pos_share, "seed": args.seed}), encoding="utf-8")
    print(f"judged {len(idx)} claims with {llm.MODEL}; flagged {sum(preds)} as unsupported -> {OUT / 'judge_preds.json'}")


if __name__ == "__main__":
    main()
