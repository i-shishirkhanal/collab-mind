"""
ml/injection/evaluate.py — prompt-injection detector results on held-out test sets.

    python -m ml.injection.evaluate --model models/injection-v1
    python -m ml.injection.evaluate                     # heuristic baseline only (no torch)

Test sets (never trained on): deepset test, jailbreak-classification test, and the in-product "poisoned chunk" set
(benign Wikipedia study chunks vs copies with an injection spliced in). Systems: regex heuristic, fine-tuned detector.
Positive class = malicious. Reported per test set: precision, recall, F1 with 95% bootstrap intervals, ROC-AUC and the
false-positive rate (share of benign texts wrongly flagged), the number that decides whether the detector is usable,
because a flagged chunk is withheld from the model. The detector's threshold is chosen on dev for max F1 under an FPR
cap (--max-fpr), then fixed.
Writes ml/data/out/injection_results.{md,json}.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

from ml.cross_encoder_train import load_predict
from ml.eval.classification import best_threshold, confusion, prf, roc_auc
from ml.eval.stats import bootstrap_stat_ci
from ml.injection import heuristic

OUT = Path(__file__).parent.parent / "data" / "out"
SETS = [("deepset test", "test_deepset"), ("jailbreak test", "test_jailbreak"), ("poisoned study chunks", "test_poisoned")]


def read(name: str) -> list[dict]:
    path = OUT / f"injection_{name}.jsonl"
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()] if path.exists() else []


def fpr(labels: list[int], preds: list[int]) -> float:
    c = confusion(labels, preds)
    return c["fp"] / (c["fp"] + c["tn"]) if c["fp"] + c["tn"] else 0.0


def threshold_under_fpr(labels: list[int], scores: list[float], max_fpr: float) -> float:
    """Highest-F1 threshold whose dev false-positive rate is <= max_fpr (falls back to max-F1 if none qualifies)."""
    best_t, best_f1 = None, -1.0
    for t in sorted(set(scores)):
        preds = [1 if s >= t else 0 for s in scores]
        if fpr(labels, preds) <= max_fpr and prf(labels, preds)["f1"] > best_f1:
            best_t, best_f1 = t, prf(labels, preds)["f1"]
    return best_t if best_t is not None else best_threshold(labels, scores)


def row(system: str, dataset: str, labels: list[int], scores: list[float], thr: float, ms: float) -> dict:
    preds = [1 if s >= thr else 0 for s in scores]
    m = prf(labels, preds)
    out = {"system": system, "dataset": dataset, "n": len(labels), "malicious": sum(labels),
           "precision": m["precision"], "recall": m["recall"], "f1": m["f1"], "fpr": fpr(labels, preds),
           "auc": roc_auc(labels, scores) if 0 < sum(labels) < len(labels) else float("nan"), "ms": round(ms, 1)}
    for key in ("f1", "recall"):
        _, out[f"{key}_lo"], out[f"{key}_hi"] = bootstrap_stat_ci(
            len(labels), lambda idx, k=key: prf([labels[i] for i in idx], [preds[i] for i in idx])[k])
    _, out["fpr_lo"], out["fpr_hi"] = bootstrap_stat_ci(
        len(labels), lambda idx: fpr([labels[i] for i in idx], [preds[i] for i in idx]))
    return out


def model_scores(predict, texts: list[str]) -> tuple[list[float], float]:
    """P(malicious) per text and mean ms per text."""
    t0 = time.perf_counter()
    logits = predict([(t, None) for t in texts])
    return [1 / (1 + math.exp(-x)) for x in logits], 1000 * (time.perf_counter() - t0) / max(1, len(texts))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", help="fine-tuned detector folder")
    ap.add_argument("--max-fpr", type=float, default=0.02, help="dev false-positive-rate cap used to pick the threshold")
    args = ap.parse_args()

    dev = read("dev")
    rows: list[dict] = []
    detector = args.model if args.model and Path(args.model).exists() else None
    if args.model and not detector:
        print(f"WARNING: {args.model} does not exist; evaluating the heuristic only", flush=True)
    dev_labels = [r["label"] for r in dev]
    predict = load_predict(detector) if detector else None
    dev_model = model_scores(predict, [r["text"] for r in dev])[0] if detector else None
    thr_model = threshold_under_fpr(dev_labels, dev_model, args.max_fpr) if detector else None

    for title, name in SETS:
        test = read(name)
        if not test:
            continue
        labels, texts = [r["label"] for r in test], [r["text"] for r in test]
        rows.append(row("regex heuristic", title, labels, [heuristic.score(t) for t in texts], 0.5, 0.0))
        if detector:
            scores, ms = model_scores(predict, texts)
            rows.append(row(f"fine-tuned DistilBERT (thr {thr_model:.2f})", title, labels, scores, thr_model, ms))

    cols = ["precision", "recall", "f1", "fpr", "auc", "n"]
    lines = ["| test set | system | " + " | ".join(cols) + " | ms/text |", "|---|---|" + "---|" * (len(cols) + 1)]
    for r in rows:
        cells = [f"{r['precision']:.3f}", f"{r['recall']:.3f} [{r['recall_lo']:.2f}, {r['recall_hi']:.2f}]",
                 f"{r['f1']:.3f} [{r['f1_lo']:.2f}, {r['f1_hi']:.2f}]", f"{r['fpr']:.3f} [{r['fpr_lo']:.3f}, {r['fpr_hi']:.3f}]",
                 "n/a" if r["auc"] != r["auc"] else f"{r['auc']:.3f}", f"{r['n']} ({r['malicious']} malicious)"]
        lines.append(f"| {r['dataset']} | {r['system']} | " + " | ".join(cells) + f" | {r['ms']:.0f} |")
    note = ("Positive class = malicious. fpr = share of benign texts wrongly flagged. Intervals are 95% bootstrap over "
            "texts. The poisoned-chunk set splices injections from the TEST split into benign Wikipedia study chunks.")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "injection_results.md").write_text("\n".join(lines) + "\n\n" + note + "\n", encoding="utf-8")
    (OUT / "injection_results.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print("\n".join(lines) + "\n\n" + note)


if __name__ == "__main__":
    main()
