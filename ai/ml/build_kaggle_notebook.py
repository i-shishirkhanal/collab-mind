"""
ml/build_kaggle_notebook.py — generate ONE self-contained Kaggle notebook that runs the whole ML pipeline.

    python -m ml.build_kaggle_notebook          # writes ml/kaggle/collabmind_ml_training.ipynb

The notebook embeds this repo's ml/ code (so nothing needs GitHub or a private repo), then on a free GPU:
  1. builds the reranker and verifier datasets from public data (BEIR SciFact, RAGTruth, MNLI),
  2. fine-tunes the reranker (MiniLM cross-encoder) and the verifier (DeBERTa-v3-small),
  3. evaluates every system on held-out test data, prints the result tables,
  4. zips the trained models and the result files for download.
Import it in Kaggle (File > Import notebook), pick the GPU accelerator, switch Internet on, Run All.
No API key is used or needed on Kaggle.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # ai/
OUT = Path(__file__).parent / "kaggle" / "collabmind_ml_training.ipynb"

FILES = [
    "ml/__init__.py",
    "ml/data/__init__.py", "ml/data/hf_rows.py", "ml/data/scifact.py", "ml/data/make_reranker_data.py",
    "ml/eval/__init__.py", "ml/eval/bm25.py", "ml/eval/metrics.py", "ml/eval/classification.py", "ml/eval/stats.py",
    "ml/eval/run_retrieval_eval.py", "ml/cross_encoder_train.py", "ml/train_reranker.py", "ml/train_biencoder.py",
    "ml/verifier/__init__.py", "ml/verifier/sentences.py", "ml/verifier/make_data.py",
    "ml/verifier/train_verifier.py", "ml/verifier/evaluate.py",
    "ml/calibration/__init__.py", "ml/calibration/platt.py", "ml/calibration/calibrate_verifier.py",
    "ml/injection/__init__.py", "ml/injection/heuristic.py", "ml/injection/make_data.py",
    "ml/injection/train_injection.py", "ml/injection/evaluate.py",
    "ml/data/indomain/chunks.jsonl",       # benign study chunks (CC BY-SA Wikipedia) for the poisoned-chunk injection test
]


def md(text: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": text.splitlines(keepends=True)}


def code(text: str) -> dict:
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
            "source": text.splitlines(keepends=True)}


def build() -> dict:
    files = {p: (ROOT / p).read_text(encoding="utf-8") for p in FILES}
    cells = [
        md("# CollabMind: reranker + claim verifier training\n"
           "Settings: **Accelerator = GPU T4 x2**, **Internet = On**. Then *Save Version -> Save & Run All* (runs unattended). "
           "Expect about 30 to 60 minutes. Stages are independent, so one failure does not stop the others.\n\n"
           "Built on public models and data, credited in the project report: `cross-encoder/ms-marco-MiniLM-L-6-v2` "
           "(Apache-2.0), `microsoft/deberta-v3-small` (MIT), `cross-encoder/nli-deberta-v3-small` (Apache-2.0), "
           "`BAAI/bge-small-en-v1.5` (MIT), BEIR SciFact, RAGTruth, MNLI."),
        code(single_cell()),
    ]
    return {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                                         "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}


SINGLE_CELL_RUNNER = '''
import base64, zlib, json, os, subprocess, shutil, time
from pathlib import Path

ROOT = Path("/kaggle/working/ai")
for rel, text in json.loads(zlib.decompress(base64.b64decode(BLOB))).items():
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
os.chdir(ROOT)
status = {}


def sh(name, cmd):
    print("\\n" + "=" * 70 + "\\n[" + name + "] $ " + cmd + "\\n" + "=" * 70, flush=True)
    t0 = time.time()
    rc = subprocess.run(cmd, shell=True).returncode
    status[name] = "ok" if rc == 0 else "FAILED (exit %d)" % rc
    print("[%s] %s after %.0fs" % (name, status[name], time.time() - t0), flush=True)
    return rc == 0


sh("install", "pip -q install sentence-transformers httpx pyarrow sentencepiece")
import torch
print("GPU available:", torch.cuda.is_available(), flush=True)

# ---- M1: reranker -------------------------------------------------------------------------------
ok = sh("m1-data", "python -m ml.data.make_reranker_data")
tuned = ok and sh("m1-train", "python -m ml.train_reranker --train ml/data/out/train.jsonl --dev ml/data/out/dev.jsonl "
                  "--base cross-encoder/ms-marco-MiniLM-L-6-v2 --out models/reranker-v1 --epochs 2")
tuned_bi = ok and sh("m1-biencoder", "python -m ml.train_biencoder --train ml/data/out/train.jsonl "
                     "--base BAAI/bge-small-en-v1.5 --out models/biencoder-v1 --epochs 3")
rerankers = "--rerank cross-encoder/ms-marco-MiniLM-L-6-v2" + (" --rerank models/reranker-v1" if tuned else "")
dense = "--dense BAAI/bge-small-en-v1.5" + (" --dense models/biencoder-v1" if tuned_bi else "")
sh("m1-eval", "python -m ml.eval.run_retrieval_eval " + dense + " " + rerankers)

# ---- M2: claim verifier -------------------------------------------------------------------------
ok = sh("m2-data", "python -m ml.verifier.make_data --mnli-rows 6000")
tuned = ok and sh("m2-train", "python -m ml.verifier.train_verifier --train ml/data/out/verifier_train.jsonl "
                  "--dev ml/data/out/verifier_dev.jsonl --out models/verifier-v1 --epochs 2")
if ok:
    scored = sh("m2-eval", "python -m ml.verifier.evaluate --save-scores ml/data/out/verifier_scores.json" + (" --model models/verifier-v1" if tuned else ""))
    if tuned and scored:
        sh("m3-calibration", "python -m ml.calibration.calibrate_verifier --scores ml/data/out/verifier_scores.json")

# ---- prompt-injection detector (the poisoned-chunk test is skipped here: it needs the local Wikipedia kit) ----
ok = sh("inj-data", "python -m ml.injection.make_data")
tuned = ok and sh("inj-train", "python -m ml.injection.train_injection --train ml/data/out/injection_train.jsonl "
                  "--dev ml/data/out/injection_dev.jsonl --out models/injection-v1 --epochs 3")
if ok:
    sh("inj-eval", "python -m ml.injection.evaluate" + (" --model models/injection-v1" if tuned else ""))

# ---- package ------------------------------------------------------------------------------------
for f in ("retrieval_results.md", "retrieval_results.json", "retrieval_per_query_ndcg10.json", "verifier_results.md",
          "verifier_results.json", "verifier_scores.json", "calibration_results.md", "calibration_results.json",
          "injection_results.md", "injection_results.json", "injection_test_poisoned.jsonl"):
    if Path("ml/data/out", f).exists():
        shutil.copy(Path("ml/data/out", f), "/kaggle/working/" + f)
if Path("models").exists():
    shutil.make_archive("/kaggle/working/collabmind_models", "zip", "models")
Path("/kaggle/working/run_status.json").write_text(json.dumps(status, indent=2))
print("\\n\\nSTATUS", json.dumps(status, indent=2))
for f in ("retrieval_results.md", "verifier_results.md", "calibration_results.md", "injection_results.md"):
    q = Path("/kaggle/working") / f
    print("\\n" + f + "\\n" + (q.read_text() if q.exists() else "(missing)"))
'''


def single_cell() -> str:
    import base64
    import zlib

    files = {p: (ROOT / p).read_text(encoding="utf-8") for p in FILES}
    blob = base64.b64encode(zlib.compress(json.dumps(files).encode("utf-8"), 9)).decode("ascii")
    return f'BLOB = "{blob}"\n' + SINGLE_CELL_RUNNER


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build(), indent=1), encoding="utf-8")
    cell = OUT.with_name("collabmind_ml_single_cell.py")
    cell.write_text(single_cell(), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB) and {cell.name} ({cell.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
