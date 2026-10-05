"""Claim splitting, premise selection, classification metrics and BM25."""

import pytest

from ml.eval import classification as c
from ml.eval.bm25 import BM25
from ml.verifier import sentences as s


def test_split_claims_strips_citations_and_drops_fragments():
    answer = "## Summary\nChlorophyll absorbs red and blue light [1]. It reflects green light [1, 2]. Yes."
    claims = s.split_claims(answer)
    assert claims == ["Chlorophyll absorbs red and blue light.", "It reflects green light."]


def test_select_premise_keeps_short_context_whole_and_picks_relevant_window_from_long():
    assert s.select_premise("anything", "short context") == "short context"
    filler = " ".join(f"Filler sentence number {i} about nothing." for i in range(200))
    ctx = filler + " The mitochondria produce ATP through oxidative phosphorylation. " + filler
    premise = s.select_premise("Mitochondria produce ATP", ctx, max_chars=300)
    assert "mitochondria produce atp" in premise.lower() and len(premise) <= 400


def test_prf_and_auc():
    labels, preds = [1, 1, 0, 0], [1, 0, 1, 0]
    m = c.prf(labels, preds)
    assert (m["tp"], m["fp"], m["fn"], m["tn"]) == (1, 1, 1, 1) and m["f1"] == pytest.approx(0.5)
    assert c.roc_auc([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8]) == pytest.approx(0.75)
    assert c.roc_auc([0, 1], [0.5, 0.5]) == pytest.approx(0.5)      # ties
    with pytest.raises(ValueError):
        c.roc_auc([1, 1], [0.2, 0.9])


def test_best_threshold_and_ece():
    labels, scores = [0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]
    t = c.best_threshold(labels, scores)
    assert 0.2 < t <= 0.8
    assert c.ece([1, 1, 0, 0], [1.0, 1.0, 0.0, 0.0]) == pytest.approx(0.0)
    assert c.ece([1, 0], [0.5, 0.5]) == pytest.approx(0.0)
    assert c.ece([0, 0], [0.9, 0.9]) == pytest.approx(0.9)


def test_bm25_ranks_the_matching_document_first():
    idx = BM25({"a": "photosynthesis converts light into chemical energy",
                "b": "the french revolution began in 1789",
                "c": "mitochondria produce energy for the cell"})
    assert idx.search("how does photosynthesis use light")[0][0] == "a"
    assert idx.search("zzzz") == []


def test_bootstrap_ci_brackets_the_mean_and_paired_test_detects_a_real_gap():
    from ml.eval import stats

    vals = [0.0, 1.0] * 50
    mean, lo, hi = stats.bootstrap_ci(vals, n_boot=500)
    assert lo < mean < hi and mean == pytest.approx(0.5)
    base = [0.5] * 100
    better = [0.6] * 100
    sig = stats.paired_bootstrap(better, base, n_boot=500)
    assert sig["lo"] > 0 and sig["p"] < 0.05
    same = stats.paired_bootstrap([0.5, 0.7] * 50, [0.7, 0.5] * 50, n_boot=500)
    assert same["lo"] < 0 < same["hi"] and same["p"] > 0.05


def test_bootstrap_stat_ci_for_a_custom_statistic():
    from ml.eval import stats

    labels = [1] * 30 + [0] * 70
    value, lo, hi = stats.bootstrap_stat_ci(100, lambda idx: sum(labels[i] for i in idx) / len(idx), n_boot=300)
    assert value == pytest.approx(0.3) and lo < 0.3 < hi
