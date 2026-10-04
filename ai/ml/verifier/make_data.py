"""
ml/verifier/make_data.py — build the claim-support dataset for the verifier.

    python -m ml.verifier.make_data

Each row: {"premise", "hypothesis", "label", "source"} with label 1 = SUPPORTED by the premise, 0 = NOT.

  * RAGTruth (wandb/RAGTruth-processed, MIT): real RAG answers from several LLMs with human span-level
    hallucination annotations. Each answer sentence becomes a claim; it is unsupported (0) if it overlaps an
    annotated hallucination span. Premise = the context windows closest to the claim (select_premise), the same
    selection the service uses. Only QA and Summary tasks (Data2txt contexts are JSON, not prose).
    Split by RESPONSE: 90% train / 10% dev from RAGTruth `train`; RAGTruth `test` is the held-out test set.
  * MNLI (nyu-mll/multi_nli): a small slice, entailment -> 1, neutral/contradiction -> 0, as general
    entailment signal for training only (never evaluated on).

Writes ml/data/out/verifier_{train,dev,test}.jsonl.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from ml.data.hf_rows import PAGE, iter_rows
from ml.verifier.sentences import MIN_CLAIM_CHARS, select_premise, sentence_spans, strip_citations

OUT = Path(__file__).parent.parent / "data" / "out"
TASKS = {"QA", "Summary"}


def ragtruth_claims(row: dict) -> list[dict]:
    output = row["output"]
    try:
        spans = [(int(s["start"]), int(s["end"])) for s in json.loads(row["hallucination_labels"] or "[]")]
    except (ValueError, KeyError, TypeError):
        return []
    out = []
    for start, end, sent in sentence_spans(output):
        if len(sent) < MIN_CLAIM_CHARS:
            continue
        bad = any(start < e and s < end for s, e in spans)
        out.append({"premise": select_premise(sent, row["context"]), "hypothesis": strip_citations(sent),
                    "label": 0 if bad else 1, "source": f"ragtruth:{row['task_type']}"})
    return out


def _is_dev(response_id: str) -> bool:
    return int(hashlib.md5(response_id.encode()).hexdigest(), 16) % 10 == 0


def build_ragtruth() -> tuple[list[dict], list[dict], list[dict]]:
    train, dev, test = [], [], []
    for r in iter_rows("wandb/RAGTruth-processed", "default", "train"):
        if r["task_type"] in TASKS:
            (dev if _is_dev(r["id"]) else train).extend(ragtruth_claims(r))
    for r in iter_rows("wandb/RAGTruth-processed", "default", "test"):
        if r["task_type"] in TASKS:
            test.extend(ragtruth_claims(r))
    return train, dev, test


def build_mnli(pages: int) -> list[dict]:
    rows, stride = [], 392_000 // max(1, pages)
    for p in range(pages):
        for r in iter_rows("nyu-mll/multi_nli", "default", "train", limit=PAGE, start=p * stride):
            rows.append({"premise": r["premise"], "hypothesis": r["hypothesis"],
                         "label": 1 if r["label"] == 0 else 0, "source": "mnli"})
    return rows


def write(name: str, rows: list[dict]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"verifier_{name}.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    pos = sum(r["label"] for r in rows)
    print(f"{name}: {len(rows)} rows, {pos} supported / {len(rows) - pos} unsupported "
          f"({100 * (len(rows) - pos) / max(1, len(rows)):.1f}% unsupported)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mnli-pages", type=int, default=60, help="x100 MNLI rows mixed into training")
    args = ap.parse_args()
    train, dev, test = build_ragtruth()
    train += build_mnli(args.mnli_pages)
    write("train", train)
    write("dev", dev)
    write("test", test)


if __name__ == "__main__":
    main()
