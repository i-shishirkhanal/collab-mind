"""
ml/injection/make_data.py — build the prompt-injection detection dataset.

    python -m ml.injection.make_data

Sources (both Apache-2.0, public):
  * deepset/prompt-injections        columns text,label        label 1 = injection
  * jackhhao/jailbreak-classification columns prompt,type      type 'jailbreak' = 1, 'benign' = 0
Rows: {"text", "label", "source"} with label 1 = malicious instruction aimed at the model.

Splits (never mixed): each dataset's own `train` is split 90/10 into train/dev by a stable hash of the text, and each
dataset's `test` is a separate held-out test file, so results are reported per source. A fourth, in-product test is
built from OUR benign study chunks (ml/data/indomain/chunks.jsonl, if present): every chunk is a benign example, and a
second copy has an injection payload taken from the TEST injections only (no train leakage) spliced into its middle,
which is how a poisoned upload would reach the model.

Writes ml/data/out/injection_{train,dev,test_deepset,test_jailbreak,test_poisoned}.jsonl.
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

from ml.data.hf_rows import iter_parquet

OUT = Path(__file__).parent.parent / "data" / "out"
INDOMAIN = Path(__file__).parent.parent / "data" / "indomain" / "chunks.jsonl"


def _rows(dataset: str, split: str, text_col: str, label_fn) -> list[dict]:
    return [{"text": r[text_col].strip(), "label": label_fn(r), "source": dataset.split("/")[1]}
            for r in iter_parquet(dataset, "default", split) if r[text_col] and r[text_col].strip()]


def load() -> dict[str, list[dict]]:
    deepset = lambda split: _rows("deepset/prompt-injections", split, "text", lambda r: int(r["label"]))
    jail = lambda split: _rows("jackhhao/jailbreak-classification", split, "prompt", lambda r: int(r["type"] == "jailbreak"))
    return {"deepset_train": deepset("train"), "deepset_test": deepset("test"),
            "jailbreak_train": jail("train"), "jailbreak_test": jail("test")}


def _is_dev(text: str) -> bool:
    return int(hashlib.md5(text.encode()).hexdigest(), 16) % 10 == 0


def poisoned_set(payloads: list[str], seed: int = 13) -> list[dict]:
    """Benign study chunks (label 0) plus copies with an injection spliced mid-chunk (label 1)."""
    if not INDOMAIN.exists() or not payloads:
        return []
    rng = random.Random(seed)
    chunks = [json.loads(x)["text"] for x in INDOMAIN.read_text(encoding="utf-8").splitlines() if x.strip()]
    out: list[dict] = []
    for text in chunks:
        out.append({"text": text, "label": 0, "source": "indomain-benign"})
        cut = text.rfind(". ", 0, len(text) // 2 + rng.randrange(-80, 80)) + 2 or len(text) // 2
        out.append({"text": text[:cut] + " " + rng.choice(payloads) + " " + text[cut:], "label": 1, "source": "indomain-poisoned"})
    return out


def write(name: str, rows: list[dict]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"injection_{name}.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    pos = sum(r["label"] for r in rows)
    print(f"{name}: {len(rows)} rows, {pos} malicious / {len(rows) - pos} benign")


def main() -> None:
    d = load()
    train, dev = [], []
    for r in d["deepset_train"] + d["jailbreak_train"]:
        (dev if _is_dev(r["text"]) else train).append(r)
    write("train", train)
    write("dev", dev)
    write("test_deepset", d["deepset_test"])
    write("test_jailbreak", d["jailbreak_test"])
    payloads = [r["text"] for r in d["deepset_test"] + d["jailbreak_test"] if r["label"] == 1 and 20 < len(r["text"]) < 400]
    poisoned = poisoned_set(payloads)
    if poisoned:
        write("test_poisoned", poisoned)
    else:
        print("no in-domain chunks found: skipping the poisoned-chunk test (run ml.data.make_indomain first)")


if __name__ == "__main__":
    main()
