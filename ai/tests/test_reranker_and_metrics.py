"""Reranker (flag, ordering, fallback, thread offload) and the retrieval metrics."""

import asyncio
import math

import pytest

import uuid_shim  # noqa: F401
from llm_helpers import chunk, retrieval_settings
from ml.eval import metrics
from rag import reranker


@pytest.fixture(autouse=True)
def clear():
    reranker.set_scorer(None)
    yield
    reranker.set_scorer(None)


class Fake:
    def __init__(self, fn):
        self.fn, self.calls = fn, []

    def score(self, pairs):
        self.calls.append(list(pairs))
        return [self.fn(q, p) for q, p in pairs]


def chunks():
    return [chunk(idx=i, text=t) for i, t in enumerate(["unrelated words", "chlorophyll absorbs red light", "mid"])]


def on(**kw):
    return retrieval_settings(reranker_enabled=True, reranker_model="fake", **kw)


def test_disabled_keeps_order_and_never_loads_a_model():
    out, info = asyncio.run(reranker.rerank_chunks(retrieval_settings(), "q", chunks(), 2))
    assert [c["chunk_index"] for c in out] == [0, 1] and not info.applied


def test_enabled_reorders_by_score_and_cuts_to_top_k():
    fake = Fake(lambda q, p: 1.0 if "chlorophyll" in p else 0.0)
    reranker.set_scorer(fake)
    out, info = asyncio.run(reranker.rerank_chunks(on(), "what absorbs light", chunks(), 2))
    assert out[0]["chunk_index"] == 1 and out[0]["rerank_score"] == 1.0 and len(out) == 2
    assert info.applied and info.candidates == 3
    assert fake.calls[0][0][0] == "what absorbs light"


def test_scoring_error_falls_back_to_retrieval_order():
    def boom(q, p):
        raise RuntimeError("cuda out of memory")

    reranker.set_scorer(Fake(boom))
    out, info = asyncio.run(reranker.rerank_chunks(on(), "q", chunks(), 2))
    assert [c["chunk_index"] for c in out] == [0, 1] and not info.applied and info.fallback_reason == "scoring failed"


def test_missing_model_falls_back_and_does_not_retry(monkeypatch):
    attempts = []

    def failing(name):
        attempts.append(name)
        raise ImportError("no sentence_transformers")

    monkeypatch.setattr(reranker, "_CrossEncoderScorer", failing)
    for _ in range(3):
        out, info = asyncio.run(reranker.rerank_chunks(on(), "q", chunks(), 2))
        assert len(out) == 2 and info.fallback_reason == "model unavailable"
    assert attempts == ["fake"]


def test_candidates_needed_widens_only_when_enabled():
    assert reranker.candidates_needed(retrieval_settings(), 6) == 6
    assert reranker.candidates_needed(on(reranker_candidates=30), 6) == 30
    assert reranker.candidates_needed(on(reranker_candidates=3), 6) == 6


def test_config_rejects_enabled_without_a_model(monkeypatch):
    import config
    monkeypatch.setenv("RERANKER_ENABLED", "true")
    monkeypatch.delenv("RERANKER_MODEL", raising=False)
    with pytest.raises(config.ConfigError):
        config.load_settings()


def test_metrics_known_values():
    ranked, relevant = ["a", "b", "c", "d"], {"b", "d"}
    assert metrics.recall_at_k(ranked, relevant, 2) == 0.5
    assert metrics.mrr_at_k(ranked, relevant) == 0.5
    expected = (1 / math.log2(3) + 1 / math.log2(5)) / (1 + 1 / math.log2(3))
    assert metrics.ndcg_at_k(ranked, relevant) == pytest.approx(expected)
    assert metrics.ndcg_at_k(["b", "d"], relevant) == pytest.approx(1.0)
    assert metrics.mrr_at_k(["x", "y"], relevant) == 0.0


def test_evaluate_averages_over_queries_and_rejects_empty():
    out = metrics.evaluate([(["a"], {"a"}), (["x", "a"], {"a"})], ks=(1,))
    assert out["recall@1"] == 0.5 and out["mrr@10"] == 0.75 and out["queries"] == 2.0
    with pytest.raises(ValueError):
        metrics.evaluate([])
    with pytest.raises(ValueError):
        metrics.recall_at_k(["a"], set(), 1)
