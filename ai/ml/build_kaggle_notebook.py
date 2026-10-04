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
    "ml/eval/__init__.py", "ml/eval/bm25.py", "ml/eval/metrics.py", "ml/eval/classification.py",
    "ml/eval/run_retrieval_eval.py", "ml/train_reranker.py",
    "ml/verifier/__init__.py", "ml/verifier/sentences.py", "ml/verifier/make_data.py",
    "ml/verifier/train_verifier.py", "ml/verifier/evaluate.py",
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
           "Settings: **Accelerator = GPU T4 x2**, **Internet = On**. Then *Run All*. Expect roughly 1 to 2 hours.\n\n"
           "Built on public models and data, credited in the project report: `cross-encoder/ms-marco-MiniLM-L-6-v2` "
           "(Apache-2.0), `microsoft/deberta-v3-small` (MIT), `cross-encoder/nli-deberta-v3-small` (Apache-2.0), "
           "`BAAI/bge-small-en-v1.5` (MIT), BEIR SciFact (CC BY-NC 4.0), RAGTruth (MIT), MNLI."),
        code('!pip -q install "sentence-transformers>=3.0,<4" httpx\n'
             'import torch; print("GPU:", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-")'),
        md("## 1. Write the project code"),
        code("import json, os\nfrom pathlib import Path\n"
             f"FILES = json.loads({json.dumps(json.dumps(files))})\n"
             "for rel, text in FILES.items():\n"
             "    p = Path('/kaggle/working/ai') / rel\n"
             "    p.parent.mkdir(parents=True, exist_ok=True)\n"
             "    p.write_text(text, encoding='utf-8')\n"
             "os.chdir('/kaggle/working/ai')\n"
             "print(len(FILES), 'files written')"),
        md("## 2. Build datasets (public data; rate-limited, takes a while)"),
        code("!python -m ml.data.make_reranker_data"),
        code("!python -m ml.verifier.make_data"),
        md("## 3. Train the reranker (M1)"),
        code("!python -m ml.train_reranker --train ml/data/out/train.jsonl --dev ml/data/out/dev.jsonl "
             "--base cross-encoder/ms-marco-MiniLM-L-6-v2 --out models/reranker-v1 --epochs 2"),
        md("## 4. Retrieval ablation on held-out SciFact test queries"),
        code("!python -m ml.eval.run_retrieval_eval --dense BAAI/bge-small-en-v1.5 "
             "--rerank cross-encoder/ms-marco-MiniLM-L-6-v2 --rerank models/reranker-v1"),
        md("## 5. Train the verifier (M2)"),
        code("!python -m ml.verifier.train_verifier --train ml/data/out/verifier_train.jsonl "
             "--dev ml/data/out/verifier_dev.jsonl --out models/verifier-v1 --epochs 2"),
        md("## 6. Verifier evaluation on held-out RAGTruth test claims"),
        code("!python -m ml.verifier.evaluate --model models/verifier-v1"),
        md("## 7. Package results and models for download"),
        code("import shutil\n"
             "shutil.copy('ml/data/out/retrieval_results.md', '/kaggle/working/')\n"
             "shutil.copy('ml/data/out/retrieval_results.json', '/kaggle/working/')\n"
             "shutil.copy('ml/data/out/verifier_results.md', '/kaggle/working/')\n"
             "shutil.copy('ml/data/out/verifier_results.json', '/kaggle/working/')\n"
             "shutil.make_archive('/kaggle/working/collabmind_models', 'zip', 'models')\n"
             "print(open('/kaggle/working/retrieval_results.md').read())\n"
             "print(open('/kaggle/working/verifier_results.md').read())"),
    ]
    return {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                                         "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build(), indent=1), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
