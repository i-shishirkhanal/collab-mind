"""
ml/calibration/calibrate_verifier.py — calibrate the verifier's P(supported) and report ECE / Brier before and after.

    python -m ml.calibration.calibrate_verifier --scores ml/data/out/verifier_scores.json --system "fine-tuned (ours)"

Needs verifier_scores.json written by `ml.verifier.evaluate --save-scores`. Platt parameters are fitted on the DEV claims
only and applied unchanged to TEST. Writes ml/data/out/calibration_results.{md,json}; the JSON carries `a` and `b` for
VERIFIER_CALIB_A / VERIFIER_CALIB_B so the service reports the calibrated score.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ml.calibration import platt
from ml.eval.classification import ece
from ml.eval.stats import bootstrap_stat_ci

OUT = Path(__file__).parent.parent / "data" / "out"


def _labels(name: str) -> list[int]:
    return [json.loads(x)["label"] for x in (OUT / f"verifier_{name}.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scores", default=str(OUT / "verifier_scores.json"))
    ap.add_argument("--system", default="fine-tuned (ours)")
    args = ap.parse_args()

    saved = json.loads(Path(args.scores).read_text(encoding="utf-8"))[args.system]
    dev_y, test_y = _labels("dev"), _labels("test")
    dev_p, test_p = saved["dev"], saved["test"]
    a, b = platt.fit(dev_p, dev_y)
    cal = [platt.apply(p, a, b) for p in test_p]

    def ci(probs):
        _, lo, hi = bootstrap_stat_ci(len(test_y), lambda idx: ece([test_y[i] for i in idx], [probs[i] for i in idx]), n_boot=500)
        return lo, hi

    rows = [("raw", test_p), ("Platt-calibrated", cal)]
    lines = ["| P(supported) | ECE [95% CI] | Brier |", "|---|---|---|"]
    result = {"system": args.system, "a": a, "b": b, "rows": {}}
    for name, probs in rows:
        e, (lo, hi), br = ece(test_y, probs), ci(probs), platt.brier(probs, test_y)
        lines.append(f"| {name} | {e:.4f} [{lo:.4f}, {hi:.4f}] | {br:.4f} |")
        result["rows"][name] = {"ece": e, "ece_lo": lo, "ece_hi": hi, "brier": br, "reliability": platt.reliability(probs, test_y)}
    rel = ["", "Reliability (test): confidence vs how often the claim really was supported", "",
           "| bin | n | raw confidence | raw observed | calibrated confidence | calibrated observed |", "|---|---|---|---|---|---|"]
    raw_bins = {r["bin"]: r for r in result["rows"]["raw"]["reliability"]}
    cal_bins = {r["bin"]: r for r in result["rows"]["Platt-calibrated"]["reliability"]}
    for k in sorted(set(raw_bins) | set(cal_bins)):
        r, c = raw_bins.get(k), cal_bins.get(k)
        rel.append(f"| {k} | {r['n'] if r else 0} / {c['n'] if c else 0} | " + (f"{r['confidence']:.3f} | {r['observed']:.3f}" if r else "- | -")
                   + " | " + (f"{c['confidence']:.3f} | {c['observed']:.3f}" if c else "- | -") + " |")
    note = f"Platt scaling fitted on {len(dev_y)} DEV claims: a={a:.3f}, b={b:.3f}. Evaluated on {len(test_y)} held-out TEST claims."
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "calibration_results.md").write_text("\n".join(lines + rel) + "\n\n" + note + "\n", encoding="utf-8")
    (OUT / "calibration_results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print("\n".join(lines + rel) + "\n\n" + note)


if __name__ == "__main__":
    main()
