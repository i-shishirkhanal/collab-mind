"""
ml/verifier/evaluate.py — the verifier results table on the held-out RAGTruth test claims.

    python -m ml.verifier.evaluate --model models/verifier-v1                 # GPU/CPU with torch
    python -m ml.verifier.evaluate --lexical-only --llm-sample 150            # no torch; spends <=150 LLM calls

Task: flag UNSUPPORTED claims (hallucination detection), so "positive" = unsupported. Systems:
    lexical          share of the claim's content words found in the premise (no learning; the floor)
    nli-zero-shot    cross-encoder/nli-deberta-v3-small, P(entailment), NOT fine-tuned by us
    fine-tuned       our model (--model)
    llm-judge        DeepSeek judging "is this claim supported by the passage" (--llm-sample N rows only)
Thresholds are chosen on the DEV file (max F1) and applied unchanged to TEST. Reported: precision, recall, F1
of the unsupported class, ROC-AUC, ECE of P(supported) (scored systems), latency per claim.
Writes ml/data/out/verifier_results.{json,md}.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import time
from pathlib import Path

from ml.eval.classification import best_threshold, ece, prf, roc_auc
from ml.eval.stats import bootstrap_stat_ci
from ml.verifier.sentences import _terms

OUT = Path(__file__).parent.parent / "data" / "out"
JUDGE_SYSTEM = ("You check whether a CLAIM is fully supported by a PASSAGE. Answer with exactly one word: "
                "SUPPORTED if the passage states or clearly implies the claim, otherwise UNSUPPORTED.")


def read(name: str) -> list[dict]:
    return [json.loads(x) for x in (OUT / f"verifier_{name}.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]


def lexical_scores(rows: list[dict]) -> list[float]:
    out = []
    for r in rows:
        want = _terms(r["hypothesis"])
        out.append(len(want & _terms(r["premise"])) / len(want) if want else 0.0)
    return out


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def model_scores(model_name: str, rows: list[dict], three_way: bool) -> tuple[list[float], float]:
    """P(supported) per row and mean ms per claim."""
    from sentence_transformers import CrossEncoder

    ce = CrossEncoder(model_name, max_length=384)
    pairs = [(r["premise"], r["hypothesis"]) for r in rows]
    t0 = time.perf_counter()
    raw = ce.predict(pairs, batch_size=32, show_progress_bar=False)
    ms = 1000 * (time.perf_counter() - t0) / max(1, len(pairs))
    if three_way:     # cross-encoder/nli-*: [contradiction, entailment, neutral]
        probs = []
        for row in raw:
            m = max(row)
            e = [math.exp(v - m) for v in row]
            probs.append(e[1] / sum(e))
        return probs, ms
    return [sigmoid(float(v)) for v in raw], ms


def _ci(labels: list[int], preds: list[int], key: str) -> tuple[float, float]:
    """95% bootstrap interval of precision / recall / f1 of the positive (unsupported) class, resampling claims.
    Claims from one answer are correlated, so this interval is, if anything, slightly too narrow."""
    _, lo, hi = bootstrap_stat_ci(len(labels), lambda idx: prf([labels[i] for i in idx], [preds[i] for i in idx])[key])
    return lo, hi


def score_row(name: str, labels_unsup: list[int], p_supported: list[float], thr_supported: float, ms: float) -> dict:
    unsup_score = [1 - p for p in p_supported]
    preds = [1 if p < thr_supported else 0 for p in p_supported]
    m = prf(labels_unsup, preds)
    row = {"system": name, "precision": m["precision"], "recall": m["recall"], "f1": m["f1"],
           "auc": roc_auc(labels_unsup, unsup_score), "ece": ece([1 - y for y in labels_unsup], p_supported),
           "latency_ms": round(ms, 1), "claims": len(labels_unsup)}
    for key in ("precision", "recall", "f1"):
        row[f"{key}_lo"], row[f"{key}_hi"] = _ci(labels_unsup, preds, key)
    return row


def threshold_from_dev(dev_rows: list[dict], dev_p: list[float]) -> float:
    unsup = [1 - r["label"] for r in dev_rows]
    t = best_threshold(unsup, [1 - p for p in dev_p])     # threshold on P(unsupported)
    return 1 - t


def llm_judge(rows: list[dict]) -> tuple[list[int], float]:
    from ml import llm

    preds, t0 = [], time.perf_counter()
    for r in rows:
        ans = llm.chat(f"PASSAGE:\n{r['premise']}\n\nCLAIM:\n{r['hypothesis']}", system=JUDGE_SYSTEM, max_tokens=4, temperature=0)
        preds.append(0 if re.match(r"\s*SUPPORTED", ans, re.I) else 1)       # 1 = flagged unsupported
    return preds, 1000 * (time.perf_counter() - t0) / max(1, len(rows))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", help="fine-tuned verifier path/id")
    ap.add_argument("--zero-shot", default="cross-encoder/nli-deberta-v3-small")
    ap.add_argument("--lexical-only", action="store_true", help="skip every neural model (no torch needed)")
    ap.add_argument("--llm-sample", type=int, default=0, help="also run the LLM judge on N test claims (stratified)")
    ap.add_argument("--llm-pos-share", type=float, default=0.33,
                    help="share of the judge sample that is unsupported claims; the subset base rate differs from the full test")
    ap.add_argument("--save-scores", help="write every system's dev/test P(supported) to this JSON (for offline reuse)")
    ap.add_argument("--load-scores", help="reuse scores saved by --save-scores instead of running neural models "
                                          "(lets the LLM judge be compared locally without the model or a GPU)")
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args()

    dev, test = read("dev"), read("test")
    unsup = [1 - r["label"] for r in test]
    rows: list[dict] = []

    dev_lex, test_lex = lexical_scores(dev), lexical_scores(test)
    thresholds = {"lexical-overlap": threshold_from_dev(dev, dev_lex)}
    rows.append(score_row("lexical-overlap", unsup, test_lex, thresholds["lexical-overlap"], 0.0))
    scored: dict[str, tuple[list[float], float]] = {"lexical-overlap": (test_lex, 0.0)}

    saved: dict[str, dict] = {}
    if args.load_scores:
        for name, d in json.loads(Path(args.load_scores).read_text(encoding="utf-8")).items():
            thresholds[name] = threshold_from_dev(dev, d["dev"])
            rows.append(score_row(name, unsup, d["test"], thresholds[name], d["ms"]))
            scored[name] = (d["test"], d["ms"])
    elif not args.lexical_only:
        for name, path, three in (("nli-zero-shot", args.zero_shot, True), ("fine-tuned (ours)", args.model, False)):
            if not path:
                continue
            if name.startswith("fine-tuned") and not Path(path).exists():
                print(f"WARNING: {path} does not exist (training failed?); skipping the fine-tuned row", flush=True)
                continue
            dev_p, _ = model_scores(path, dev, three)
            test_p, ms = model_scores(path, test, three)
            thresholds[name] = threshold_from_dev(dev, dev_p)
            rows.append(score_row(name, unsup, test_p, thresholds[name], ms))
            scored[name] = (test_p, ms)
            saved[name] = {"dev": dev_p, "test": test_p, "ms": ms}
        if args.save_scores and saved:
            Path(args.save_scores).write_text(json.dumps(saved), encoding="utf-8")

    sample_rows: list[dict] = []
    if args.llm_sample:
        rng = random.Random(args.seed)
        pos_idx = [i for i, y in enumerate(unsup) if y == 1]
        neg_idx = [i for i, y in enumerate(unsup) if y == 0]
        rng.shuffle(pos_idx)
        rng.shuffle(neg_idx)
        n_pos = round(args.llm_sample * args.llm_pos_share)      # enough hallucinated claims for a usable recall/precision
        idx = sorted(pos_idx[:n_pos] + neg_idx[: args.llm_sample - n_pos])
        sub, sub_unsup = [test[i] for i in idx], [unsup[i] for i in idx]
        preds, ms = llm_judge(sub)
        m = prf(sub_unsup, preds)
        judge = {"system": "llm-judge (DeepSeek)", "precision": m["precision"], "recall": m["recall"], "f1": m["f1"],
                 "auc": float("nan"), "ece": float("nan"), "latency_ms": round(ms, 1), "claims": len(sub)}
        for key in ("precision", "recall", "f1"):
            judge[f"{key}_lo"], judge[f"{key}_hi"] = _ci(sub_unsup, preds, key)
        sample_rows.append(judge)
        for name, (probs, lat) in scored.items():
            sample_rows.append(score_row(f"{name} [same subset]", sub_unsup, [probs[i] for i in idx], thresholds[name], lat))

    base_rate = sum(unsup) / len(unsup)
    cols = ["precision", "recall", "f1", "auc", "ece", "latency_ms", "claims"]

    def table(title: str, rs: list[dict]) -> list[str]:
        out = [f"### {title}", "", "| system | " + " | ".join(cols) + " |", "|---|" + "---|" * len(cols)]
        for r in rs:
            def cell(c: str) -> str:
                if isinstance(r[c], float) and math.isnan(r[c]):
                    return "n/a"
                if c in ("latency_ms", "claims"):
                    return f"{r[c]:.0f}"
                if f"{c}_lo" in r:
                    return f"{r[c]:.3f} [{r[c + '_lo']:.3f}, {r[c + '_hi']:.3f}]"
                return f"{r[c]:.3f}"

            out.append(f"| {r['system']} | " + " | ".join(cell(c) for c in cols) + " |")
        return out + [""]

    md = table(f"Held-out RAGTruth test claims (unsupported = positive class; base rate {base_rate:.1%})", rows)
    if sample_rows:
        md += table(f"LLM-judge comparison on a stratified subset of {args.llm_sample} test claims "
                    f"(unsupported share {args.llm_pos_share:.0%}, so precision is not comparable to the full-test table; "
                    "all systems below see the same claims, the judge prompt is a frozen constant, temperature 0)", sample_rows)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "verifier_results.md").write_text("\n".join(md), encoding="utf-8")
    (OUT / "verifier_results.json").write_text(json.dumps({"test": rows, "subset": sample_rows}, indent=2), encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
