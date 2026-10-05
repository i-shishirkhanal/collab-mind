# ML results log

Numbers recorded as they are produced. Nothing here is rounded in our favour; weak or negative findings stay in.
Intervals and significance tests are added by `ml/eval/stats.py` in the next evaluation run (not in run 1).

## M1: retrieval ablation (run 1, Kaggle T4 GPU, 2026-10-05)

Benchmark: BEIR SciFact, 300 held-out test queries, 5,183 abstracts. The reranker was fine-tuned on the SciFact
**train** queries only (829 positives + 3,316 BM25 hard negatives, 2 epochs, base `cross-encoder/ms-marco-MiniLM-L-6-v2`).
The reranker scores the top 50 candidates of each first stage. Latency is the reranker stage per query on the GPU.

| System | Recall@1 | Recall@10 | MRR@10 | NDCG@10 | ms/query |
|---|---|---|---|---|---|
| BM25 | 0.531 | 0.784 | 0.635 | 0.666 | |
| Dense `bge-small-en-v1.5` | 0.593 | 0.841 | 0.692 | 0.724 | |
| Hybrid (BM25 + dense, RRF) | 0.594 | 0.845 | 0.689 | 0.723 | |
| BM25 + off-the-shelf reranker | 0.542 | 0.800 | 0.651 | 0.680 | 251 |
| Dense + off-the-shelf reranker | 0.555 | 0.826 | 0.666 | 0.699 | 254 |
| Hybrid + off-the-shelf reranker | 0.545 | 0.832 | 0.659 | 0.694 | 253 |
| BM25 + **our** reranker | 0.606 | 0.824 | 0.707 | 0.730 | 250 |
| Dense + **our** reranker | 0.613 | 0.831 | 0.710 | 0.735 | 254 |
| Hybrid + **our** reranker | **0.620** | **0.858** | **0.725** | **0.751** | 253 |

A CPU-trained copy of the same reranker (same data and recipe) scored NDCG@10 0.725 on BM25 candidates, against 0.730 on
the GPU run. That 0.005 gap is run-to-run noise, which is also a sanity check on how small a "real" difference can be here.

### Reading it honestly
- Our reranker on hybrid candidates is the best system (0.751), +0.027 NDCG@10 over dense alone and +0.085 over BM25.
  **No confidence interval yet**: with 300 queries a 2 to 3 point gap may not be significant. Do not claim it until the
  paired bootstrap in run 2 excludes zero.
- The off-the-shelf MS MARCO reranker makes BM25 slightly better but makes dense and hybrid **worse** (0.699, 0.694 vs
  0.724, 0.723). General web-search relevance does not transfer to scientific claims. Our fine-tune fixes that, so the
  headline gain is **in-domain adaptation**, not a better architecture. The comparison with the off-the-shelf model is
  therefore not like-for-like and must be described as domain adaptation.
- Cost: about 0.25 s per query on a GPU for 50 candidates (CPU is slower), versus no cost for retrieval alone.

### Limitations
- One dataset (SciFact), trained and tested on the same domain; generalisation is untested until the in-domain
  Wikipedia study kit is labelled (48 draft questions is small; 100+ would be better).
- Single training seed; no variance estimate across seeds.

## M2: claim verifier (RAGTruth, held-out test = 10,366 claims, 5.9% unsupported)

Positive class = unsupported claim (hallucination detection). Thresholds are chosen on the dev set and applied unchanged.

| System | Precision | Recall | F1 | AUC | ECE |
|---|---|---|---|---|---|
| Lexical overlap (no learning) | 0.149 | 0.474 | 0.227 | 0.747 | 0.251 |
| Off-the-shelf NLI (zero-shot) | pending | | | | |
| Fine-tuned DeBERTa-v3-small (ours) | pending | | | | |
| Fine-tuned MiniLM NLI, CPU-trained (ours) | pending | | | | |
| LLM judge (DeepSeek, stratified subset) | pending | | | | |

Run 1 crashed in verifier training (transformers 5 loaded the weights in fp16, which the gradient scaler rejects); fixed
by forcing fp32 master weights in `ml/cross_encoder_train.py`. A second run is needed.

### Limitations to state in the report
- RAGTruth labels are human span annotations mapped to sentences by overlap, which adds label noise at sentence boundaries.
- Claims from one answer are correlated, so bootstrap intervals over claims are slightly too narrow.
- The judge comparison uses a stratified subset (a higher share of unsupported claims), so its precision is not comparable
  with the full-test table; all systems are compared on the same subset.
