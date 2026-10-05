# ML results log

Numbers recorded as they are produced. Nothing is rounded in our favour; weak or negative findings stay in.
Intervals are 95% percentile bootstrap (`ml/eval/stats.py`). We only claim a difference when its interval excludes 0.
All training/evaluation runs below are on Kaggle (Tesla T4) unless stated; code is in `ai/ml/`.

## M1: retrieval ablation (run 2, 2026-10-05)

Benchmark: BEIR SciFact, 300 held-out test queries, 5,183 abstracts. The reranker was fine-tuned on the SciFact
**train** queries only (829 positives + 3,316 BM25 hard negatives, 2 epochs, base `cross-encoder/ms-marco-MiniLM-L-6-v2`,
about 75 s on the T4). It re-scores the top 50 candidates of each first stage. Latency is the reranker stage per query (GPU).

| System | Recall@1 | Recall@10 | MRR@10 | NDCG@10 [95% CI] | Δ vs BM25 [95% CI] | ms |
|---|---|---|---|---|---|---|
| BM25 | 0.531 | 0.784 | 0.635 | 0.666 [0.619, 0.710] | | |
| Dense `bge-small-en-v1.5` | 0.593 | 0.841 | 0.692 | 0.724 [0.680, 0.768] | +0.058 [+0.020, +0.095] | |
| Hybrid (BM25 + dense, RRF) | 0.594 | 0.845 | 0.689 | 0.723 [0.681, 0.766] | +0.057 [+0.035, +0.081] | |
| BM25 + off-the-shelf reranker | 0.542 | 0.800 | 0.651 | 0.680 [0.635, 0.724] | +0.014 [-0.015, +0.045] | 258 |
| Dense + off-the-shelf reranker | 0.555 | 0.826 | 0.666 | 0.699 [0.656, 0.741] | +0.032 [-0.001, +0.066] | 260 |
| Hybrid + off-the-shelf reranker | 0.545 | 0.832 | 0.659 | 0.694 [0.652, 0.736] | +0.028 [-0.004, +0.060] | 258 |
| BM25 + **our** reranker | 0.606 | 0.820 | 0.706 | 0.729 [0.686, 0.770] | +0.062 [+0.034, +0.092] | 256 |
| Dense + **our** reranker | 0.616 | 0.831 | 0.710 | 0.736 [0.693, 0.779] | +0.070 [+0.037, +0.104] | 259 |
| Hybrid + **our** reranker | **0.622** | **0.855** | **0.724** | **0.751** [0.711, 0.793] | **+0.085** [+0.052, +0.119] | 258 |

(An earlier GPU run and a CPU-trained copy of the same recipe gave NDCG@10 0.730 / 0.725 for BM25 + our reranker, against 0.729
here: run-to-run noise of about 0.005, so differences of that size mean nothing.)

### Reading it honestly
- **Supported:** hybrid + our reranker beats BM25 by +0.085 with an interval well above zero.
- **Not yet supported:** that it beats the strongest non-reranked system (dense or hybrid, 0.723 to 0.724). The gap is about
  +0.027 and the intervals overlap heavily. The next evaluation run adds a paired test against the best no-reranker row;
  until it excludes zero, the right claim is "at least as good as dense retrieval, with a better top-1 (Recall@1 0.622 vs 0.593)".
- **The off-the-shelf MS MARCO reranker does not help** on SciFact (no interval excludes zero versus BM25, and it lowers dense and
  hybrid). General web-search relevance does not transfer to scientific claims. Our fine-tune fixes that, so the gain is
  **in-domain adaptation**, not a better architecture, and the comparison with the off-the-shelf model is not like-for-like.
- Cost: about 0.26 s per query for 50 candidates on a GPU; slower on CPU.

### Limitations
- One dataset (SciFact), trained and tested on the same domain; generalisation is untested until the in-domain Wikipedia kit
  is labelled (48 draft questions is small; 100+ would be better).
- Single training seed; no variance across seeds.

## M2: claim-support verifier (run 2)

Task: flag UNSUPPORTED claims in RAG answers (hallucination detection); positive class = unsupported. Test = RAGTruth held-out,
QA + Summary tasks, **10,366 claims, 5.9% unsupported**. Thresholds chosen on the dev set, applied unchanged.
Fine-tuned: `microsoft/deberta-v3-small`, 60,844 training pairs (RAGTruth train + 6,000 MultiNLI), 2 epochs (about 43 min on the T4);
best epoch was **1** (dev AUC 0.891 vs 0.889 after epoch 2), a mild sign of overfitting in epoch 2.

| System | Precision [95% CI] | Recall [95% CI] | F1 [95% CI] | AUC | ECE | ms/claim (GPU) |
|---|---|---|---|---|---|---|
| Lexical overlap (no learning) | 0.149 [0.134, 0.165] | 0.474 [0.434, 0.513] | 0.227 [0.206, 0.249] | 0.747 | 0.251 | |
| Off-the-shelf NLI, zero-shot | 0.095 [0.081, 0.110] | 0.257 [0.223, 0.289] | 0.139 [0.119, 0.158] | 0.643 | 0.719 | 14 |
| **Fine-tuned DeBERTa-v3-small (ours)** | **0.457** [0.421, 0.496] | **0.525** [0.484, 0.564] | **0.488** [0.453, 0.520] | **0.863** | 0.233 | 14 |
| LLM judge (DeepSeek) | pending (stratified subset, run locally) | | | | | |

### Reading it honestly
- Fine-tuning roughly **doubles F1 over the lexical baseline** (0.488 vs 0.227, intervals far apart) and lifts AUC from 0.747 to 0.863.
- The **off-the-shelf NLI model is worse than simple word overlap** (F1 0.139). General NLI does not transfer to sentence-level
  RAG claims against retrieved passages, which is the reason to fine-tune on RAG-specific labels.
- Even the best model catches about half of the hallucinated claims (recall 0.525) and about half of its alarms are false
  (precision 0.457). Useful as a flag, not as a guarantee; the UI should show a score and highlight claims, not claim certainty.
- **Calibration is poor** (ECE 0.233): the raw score is not a probability. Platt scaling is implemented (`ml/calibration`)
  and runs in the next notebook version.

### Limitations to state in the report
- RAGTruth labels are human span annotations mapped to sentences by overlap, which adds label noise at sentence boundaries.
- Claims from one answer are correlated, so intervals over claims are slightly too narrow.
- RAGTruth answers come from other LLMs, not from our platform's generator; the in-domain claim set (109 claims, labels pending)
  is the check that it transfers.
- The judge comparison uses a stratified subset (higher unsupported share), so its precision is not comparable with the
  full-test table; every system is compared on the same claims.

## Not yet run
Bi-encoder fine-tune, prompt-injection detector, calibration (code and tests are done; they run in the next notebook version).
