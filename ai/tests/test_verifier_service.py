"""rag/verifier.py: flag, claim/citation mapping, thresholding, fallback, thread offload."""

import asyncio

import pytest

from config import VerifierSettings
from rag import verifier


@pytest.fixture(autouse=True)
def clear():
    verifier.set_scorer(None)
    yield
    verifier.set_scorer(None)


class Fake:
    def __init__(self, fn):
        self.fn, self.calls = fn, []

    def score(self, pairs):
        self.calls.append(list(pairs))
        return [self.fn(prem, claim) for prem, claim in pairs]


PASSAGES = [{"content": "Chlorophyll absorbs red and blue light in the chloroplast."},
            {"content": "The French Revolution began in 1789 in Paris."}]
ANSWER = ("Chlorophyll absorbs red and blue light [1]. The French Revolution began in 1799 [2]. "
          "Photosynthesis happens at night in most plants.")
ON = VerifierSettings(enabled=True, model="fake", threshold=0.5, max_claims=12)


def run(cfg=ON, answer=ANSWER, passages=PASSAGES):
    return asyncio.run(verifier.verify_answer(cfg, answer, passages))


def test_disabled_does_nothing_and_loads_no_model():
    assert run(VerifierSettings()) is None


def test_claims_carry_their_cited_passage_numbers():
    claims = verifier.claims_with_citations(ANSWER, 12)
    assert [c for _, c in claims] == [[1], [2], []]
    assert claims[0][0] == "Chlorophyll absorbs red and blue light."


def test_flags_unsupported_claims_and_scores_share_supported():
    verifier.set_scorer(Fake(lambda prem, claim: 0.1 if ("1799" in claim or "night" in claim) else 0.9))
    f = run()
    assert f.claims_checked == 3 and f.score == pytest.approx(1 / 3, abs=1e-3)
    assert [u.text for u in f.unsupported] == [
        "The French Revolution began in 1799.", "Photosynthesis happens at night in most plants."]


def test_cited_claim_is_scored_against_only_its_cited_passage():
    fake = Fake(lambda prem, claim: 0.9)
    verifier.set_scorer(fake)
    run()
    premise_for_claim_2 = fake.calls[0][1][0]
    assert "1789" in premise_for_claim_2 and "Chlorophyll" not in premise_for_claim_2
    premise_uncited = fake.calls[0][2][0]
    assert "Chlorophyll" in premise_uncited and "1789" in premise_uncited     # all passages


def test_max_claims_bounds_work():
    verifier.set_scorer(Fake(lambda *_: 0.9))
    assert run(VerifierSettings(enabled=True, model="fake", max_claims=2)).claims_checked == 2


def test_scorer_failure_or_wrong_length_leaves_answer_unscored():
    class Boom:
        def score(self, pairs):
            raise RuntimeError("cuda out of memory")

    verifier.set_scorer(Boom())
    assert run() is None

    class Short:
        def score(self, pairs):
            return [0.9]

    verifier.set_scorer(Short())
    assert run() is None


def test_unloadable_model_is_not_retried():
    cfg = VerifierSettings(enabled=True, model="/definitely/not/a/model")
    assert run(cfg) is None
    assert run(cfg) is None
    assert verifier._load_failed_for == "/definitely/not/a/model"
