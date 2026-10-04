# CollabMind: In-house Deep Learning Plan (Final Year Project)

## Thesis

Gemini is the *generator*. Three models we train ourselves are the *gatekeepers* around it:
what gets retrieved, whether the answer is supported by it, and how far to trust it.
Every model is compared against the system as it exists today, and all results are reported, including negative ones.

## Current baseline (what we must beat)

| Stage | Today (in repo) |
|---|---|
| Embeddings | BGE-M3 via OpenAI-compatible endpoint (`ai/rag/embedding_provider.py`), **not** Gemini embeddings |
| Retrieval | pgvector + Postgres FTS, fused by Reciprocal Rank Fusion, similarity thresholds (`ai/rag/retriever.py`) |
| Citations | Model emits `[n]`; `ai/rag/grounding.py` only checks the number maps to a real chunk. There is **no semantic check** that the chunk supports the claim |
| Confidence | None computed by a trained model |

## Deliverables

### M1. Neural reranker + domain-adapted embeddings (retrieval)
- **Reranker:** fine-tune a cross-encoder (MiniLM-L6 / BGE-reranker-base) with hard negatives mined from the current retriever. Loss: binary cross-entropy / margin ranking on (query, passage) pairs.
- **Bi-encoder (ablation):** fine-tune MiniLM/BGE-small with MultipleNegativesRankingLoss (InfoNCE). Expectation: may *not* beat BGE-M3. Report honestly; the reranker is the likely win.
- **Data:** MS MARCO / SQuAD for the base; synthetic (question, chunk) pairs generated from real uploaded sources for domain adaptation. Test set = held-out real student questions with hand-marked relevant chunks.
- **Metrics:** Recall@k, MRR@10, NDCG@10, latency (ms).
- **Ablation table:** BM25 only | BGE-M3 | BGE-M3 + FTS (RRF, current) | + fine-tuned bi-encoder | + reranker | full.
- **Integration:** reranker runs after `retrieve_chunks` in `ai/rag/pipeline.py`, behind a config flag with the current path as fallback.

### M2. Citation faithfulness verifier (trust)
- **Model:** DeBERTa-v3 NLI (start from an MNLI checkpoint), fine-tuned on SciFact-style data plus our own labels.
- **Method:** split the answer into claims; premise = cited chunk(s), hypothesis = claim; 3-way softmax (entail / neutral / contradict) -> per-claim and per-answer faithfulness score shown in the UI.
- **Data:** ~300 Gemini answers from the platform, each claim hand-labeled supported / unsupported (the main manual cost; start early).
- **Metrics:** precision, recall, F1, ROC-AUC, confusion matrix.
- **Baseline:** Gemini judging its own answer with a prompt, and the current "citation index exists" check.
- **Integration:** runs in `ai/rag/grounding.py` after `resolve_citations`.

### M3. Calibrated confidence (small extension, reuses M1 + M2)
- Small regressor over retrieval scores, reranker scores and verifier output, predicting "answer is correct and supported".
- **Metrics:** Expected Calibration Error, reliability diagram, vs. raw similarity score and Gemini self-reported confidence.
- One method only. No multi-sample entropy (multiplies Gemini cost).

### Stretch (only if M1 and M2 are done by the midpoint)
Knowledge tracing (DKT/SAKT vs. BKT on ASSISTments, AUC) to pick the next quiz question per member.

### Explicitly out of scope
Neural chunk-boundary / chunk-quality multitask model (no labels, no honest way to measure the gain).

## Rules we hold ourselves to
1. Every model has a baseline and a row in the results table, even if it loses.
2. Held-out test data is fixed before tuning and never used for training.
3. The model must run inside the platform (flagged, with fallback), not only in a notebook.
4. Report latency and cost, not only accuracy.
5. Describe the system accurately: "retrieval and verification models trained in-house", not "neuro-symbolic" or "enterprise-grade".

## Schedule (adjust to actual deadline)

| Weeks | Work |
|---|---|
| 1 | Eval harness (`ai/ml/eval`), build test set of real questions with relevant chunks, run baseline numbers |
| 2-3 | M1: mine hard negatives, train reranker (Colab), ablation, integrate |
| 3-4 | M1: bi-encoder fine-tune, loss curves, finish ablation table. **Start labeling M2 data in parallel** |
| 5-7 | M2: claim splitter, NLI fine-tune, evaluation vs Gemini-as-judge, integrate faithfulness score in UI |
| 8 | M3: calibration model, ECE plots |
| 9-10 | Stretch (knowledge tracing) or buffer; report chapters, viva prep |

## Why this works as a final year project
- Answers "what did you train?" with three concrete models, each with data, loss, metric and baseline.
- Each model fixes a gap that exists in the code today (rank quality, no semantic citation check, no calibrated confidence), so it is not decoration.
- Results are measurable and reproducible; a negative result is reportable and still scores.
- Scope is realistic: two core models, one small extension, one optional stretch.
