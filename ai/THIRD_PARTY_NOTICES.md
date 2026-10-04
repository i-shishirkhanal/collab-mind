# Third-Party Notices — AI Service

Document extraction in the `ai/` service uses open-source libraries, consumed
as pinned pip dependencies (`requirements.txt`). **No upstream source code is
copied, vendored or modified in this repository.**

## MarkItDown

- **Source**: https://github.com/microsoft/markitdown
- **Version**: `markitdown==0.1.8`, installed with the extras
  `pdf,docx,pptx,xlsx,xls`
- **License**: MIT (verified from the package metadata and upstream
  `pyproject.toml`)
- **Used by**: `rag/extractor.py`, which converts PDF / DOCX / PPTX / XLSX /
  XLS / HTML / CSV / JSON / Markdown / text to markdown, then splits the result
  into page / slide / sheet / section blocks so citations can point at a real
  location.
- **Parts of the upstream repository not used**: the `markitdown-mcp` server,
  the sample plugins, the OCR / Azure Document Intelligence / audio
  transcription / YouTube / Outlook converters. Plugins are explicitly disabled
  (`enable_plugins=False`) and MarkItDown is never given a URL to fetch — web
  pages are downloaded by our own SSRF-guarded fetcher and passed in as bytes.

## Licenses of the dependencies MarkItDown brings in

Read from the installed package metadata (not assumed):

| Package | Version | License |
|---|---|---|
| pdfminer.six | 20260107 | MIT |
| pdfplumber | 0.11.10 | MIT |
| mammoth | 1.11.0 | BSD-2-Clause |
| python-pptx | 1.0.2 | MIT |
| openpyxl | 3.1.5 | MIT |
| pandas | 3.0.6 | BSD-3-Clause |
| xlrd | 2.0.2 | BSD |
| lxml | 6.1.3 | BSD-3-Clause |
| magika | 0.6.3 | Apache-2.0 |
| onnxruntime | 1.30.0 | MIT |
| beautifulsoup4 | 4.15.0 | MIT |
| markdownify | 1.2.3 | MIT |
| charset-normalizer | 3.5.2 | MIT |
| defusedxml | 0.7.1 | PSF-2.0 |

All are permissive licenses. None imposes copyleft or an online-service
attribution requirement; keep the packages' own license files intact (pip does
this when installing).

## Re-check when upgrading

Versions are pinned; re-run the license read-out above after any upgrade of
`markitdown` or its extras, since transitive dependencies can change license.

# Machine-learning components (`ml/`, `rag/reranker.py`, `rag/verifier.py`)

These are used and fine-tuned by us; the pretrained weights and public datasets below are the work of their
authors and are credited here and in the project report. Licenses were read from each Hugging Face
model/dataset card on 2026-10-05. **Re-check before submission; trained weights inherit the base model's licence.**

## Pretrained models (starting points we fine-tune or compare against)

| Model | Used for | Licence (from card) |
|---|---|---|
| `cross-encoder/ms-marco-MiniLM-L-6-v2` (Reimers et al., UKP Lab) | Base for our fine-tuned reranker; off-the-shelf baseline | Apache-2.0 |
| `microsoft/deberta-v3-small` (He et al., Microsoft) | Base for our fine-tuned claim verifier | MIT |
| `cross-encoder/nli-deberta-v3-small` (UKP Lab) | Zero-shot NLI baseline for the verifier (not fine-tuned by us) | Apache-2.0 |
| `BAAI/bge-small-en-v1.5` (BAAI) | Dense first-stage baseline in the retrieval ablation | MIT |

## Datasets

| Dataset | Used for | Licence (from card) / note |
|---|---|---|
| BEIR `SciFact` (Thakur et al., 2021; Wadden et al., 2020) | Reranker training queries (train qrels) and the held-out retrieval test (test qrels) | Card: CC BY-SA 4.0. The upstream SciFact release is CC BY-NC; treated as non-commercial research use |
| `RAGTruth` via `wandb/RAGTruth-processed` (Niu et al., 2024) | Verifier training and held-out test (answer sentences with human hallucination spans) | The dataset card states no licence; research use only. Check the upstream repository before redistributing |
| `MultiNLI` (Williams et al., 2018) | Optional entailment signal mixed into verifier training | Mixed per genre: CC BY 3.0, CC BY-SA 3.0, MIT, other |
| English Wikipedia articles | Small in-domain study-material test kit (`ml/data/make_indomain.py`; not committed) | CC BY-SA 4.0 — attribution to the article authors required |

## Libraries

PyTorch (BSD-3-Clause), Hugging Face `transformers` and `sentence-transformers` (Apache-2.0), `pyarrow`
(Apache-2.0), `httpx` (BSD-3-Clause). Consumed as pip dependencies (`requirements-ml.txt`); no source copied.

## What is our own work

The training loop (`ml/cross_encoder_train.py`), data builders, BM25 and metrics code, evaluation harness,
claim splitter, premise selection, service integration (`rag/reranker.py`, `rag/verifier.py`) and every
number in the results tables. Fine-tuned weights are derived works of the base models above.
