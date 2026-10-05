"""
ml/eval/run_retrieval_eval.py — the retrieval ablation table on the held-out BEIR SciFact test queries.

    python -m ml.eval.run_retrieval_eval                                   # BM25 only (CPU, no torch)
    python -m ml.eval.run_retrieval_eval --dense BAAI/bge-small-en-v1.5 \
        --rerank cross-encoder/ms-marco-MiniLM-L-6-v2 --rerank models/reranker-v1

Systems reported (each a row; every number is on the SAME 300 test queries):
    bm25                      lexical first stage
    dense:<model>             bi-encoder first stage (needs sentence-transformers)
    hybrid:<model>            BM25 + dense fused with Reciprocal Rank Fusion (like the platform's hybrid search)
    <first stage>+rerank:<m>  cross-encoder re-scores the top --candidates of that first stage
Metrics: Recall@1/5/10, MRR@10, NDCG@10, and mean latency per query in ms (reranker stage only for rerank rows).
Writes ml/data/out/retrieval_results.{json,md}.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from ml.data import scifact
from ml.eval.bm25 import BM25
from ml.eval.metrics import evaluate, ndcg_at_k
from ml.eval.stats import bootstrap_ci, paired_bootstrap

OUT = Path(__file__).parent.parent / "data" / "out"
RRF_K = 60


def rrf(*rankings: list[str], k: int = RRF_K) -> list[str]:
    score: dict[str, float] = {}
    for ranking in rankings:
        for rank, doc in enumerate(ranking, start=1):
            score[doc] = score.get(doc, 0.0) + 1.0 / (k + rank)
    return sorted(score, key=score.get, reverse=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dense", action="append", default=[], help="sentence-transformers bi-encoder id/path; repeatable")
    ap.add_argument("--rerank", action="append", default=[], help="cross-encoder id/path; repeatable")
    ap.add_argument("--candidates", type=int, default=50, help="first-stage depth given to the reranker")
    ap.add_argument("--limit", type=int, default=0, help="evaluate only the first N test queries (smoke test)")
    args = ap.parse_args()

    corpus, queries, qrels = scifact.load_corpus(), scifact.load_queries(), scifact.load_qrels("test")
    qids = sorted(qrels)[: args.limit or None]
    bm25 = BM25(corpus)
    depth = max(100, args.candidates)

    first_stage: dict[str, dict[str, list[str]]] = {"bm25": {q: [d for d, _ in bm25.search(queries[q], depth)] for q in qids}}
    if args.dense:
        from sentence_transformers import SentenceTransformer

        ids = list(corpus)
        for dense_name in args.dense:
            enc = SentenceTransformer(dense_name)
            doc_vecs = enc.encode([corpus[i] for i in ids], batch_size=64, normalize_embeddings=True, show_progress_bar=False)
            q_vecs = enc.encode([queries[q] for q in qids], batch_size=64, normalize_embeddings=True, show_progress_bar=False)
            sims = q_vecs @ doc_vecs.T
            dense = {q: [ids[j] for j in sims[n].argsort()[::-1][:depth]] for n, q in enumerate(qids)}
            first_stage[f"dense:{dense_name}"] = dense
            first_stage[f"hybrid:{dense_name}"] = {q: rrf(first_stage["bm25"][q], dense[q])[:depth] for q in qids}

    results: list[dict] = []
    per_query: dict[str, list[float]] = {}          # system -> NDCG@10 per test query (same order as qids)

    def record(name: str, ranked_by_q: dict[str, list[str]], latency_ms: float = 0.0) -> None:
        metrics = evaluate([(ranked_by_q[q], qrels[q]) for q in qids])
        per_query[name] = [ndcg_at_k(ranked_by_q[q], qrels[q], 10) for q in qids]
        _, lo, hi = bootstrap_ci(per_query[name])
        results.append({"system": name, **metrics, "ndcg_lo": lo, "ndcg_hi": hi, "latency_ms": round(latency_ms, 1)})
        print(f"{name:<60} MRR@10={metrics['mrr@10']:.3f} NDCG@10={metrics['ndcg@10']:.3f} R@10={metrics['recall@10']:.3f}")

    for name, ranked in first_stage.items():
        record(name, ranked)

    for model_name in args.rerank:
        from sentence_transformers import CrossEncoder

        ce = CrossEncoder(model_name, max_length=512)
        for stage, ranked in first_stage.items():
            reranked, spent = {}, 0.0
            for q in qids:
                cands = ranked[q][: args.candidates]
                t0 = time.perf_counter()
                scores = ce.predict([(queries[q], corpus[d]) for d in cands], batch_size=32, show_progress_bar=False)
                spent += time.perf_counter() - t0
                reranked[q] = [d for d, _ in sorted(zip(cands, scores), key=lambda x: x[1], reverse=True)]
            record(f"{stage}+rerank:{model_name}", reranked, 1000 * spent / len(qids))

    OUT.mkdir(parents=True, exist_ok=True)
    ref = results[0]["system"]                       # paired comparisons are against the first system (BM25)
    first_rows = [r for r in results if "+rerank" not in r["system"]]
    best = max(first_rows, key=lambda r: r["ndcg@10"])["system"]       # strongest system WITHOUT a reranker
    for r in results:
        d = paired_bootstrap(per_query[r["system"]], per_query[ref])
        r.update({"delta_vs_ref": d["diff"], "delta_lo": d["lo"], "delta_hi": d["hi"], "delta_p": d["p"]})
        b = paired_bootstrap(per_query[r["system"]], per_query[best])
        r.update({"delta_vs_best": b["diff"], "best_lo": b["lo"], "best_hi": b["hi"], "best_p": b["p"]})
    (OUT / "retrieval_results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    (OUT / "retrieval_per_query_ndcg10.json").write_text(json.dumps({"qids": qids, "ndcg@10": per_query}), encoding="utf-8")
    cols = ["recall@1", "recall@10", "mrr@10"]
    head = ["system", *cols, "ndcg@10 [95% CI]", f"delta vs {ref} [95% CI]", "p", f"delta vs best no-reranker [95% CI]", "p ", "latency_ms"]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for r in results:
        sig = "" if r["system"] == ref else f"{r['delta_vs_ref']:+.3f} [{r['delta_lo']:+.3f}, {r['delta_hi']:+.3f}]"
        pval = "" if r["system"] == ref else f"{r['delta_p']:.3f}"
        sig_b = "" if r["system"] == best else f"{r['delta_vs_best']:+.3f} [{r['best_lo']:+.3f}, {r['best_hi']:+.3f}]"
        pval_b = "" if r["system"] == best else f"{r['best_p']:.3f}"
        lines.append(f"| {r['system']} | " + " | ".join(f"{r[c]:.3f}" for c in cols)
                     + f" | {r['ndcg@10']:.3f} [{r['ndcg_lo']:.3f}, {r['ndcg_hi']:.3f}] | {sig} | {pval} | {sig_b} | {pval_b} | {r['latency_ms']:.0f} |")
    note = (f"Test queries: {len(qids)} (BEIR SciFact test). Intervals are 95% percentile bootstrap over queries; the delta "
            f"column is a paired bootstrap against the first row; 'best no-reranker' is {best}. A difference is only claimed when its interval excludes 0.")
    (OUT / "retrieval_results.md").write_text("\n".join(lines) + "\n\n" + note + "\n", encoding="utf-8")
    print("\n" + "\n".join(lines) + "\n\n" + note)


if __name__ == "__main__":
    main()
