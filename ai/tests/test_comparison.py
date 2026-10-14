import asyncio
import pytest
from rag import comparison
from rag.generator import NoRelevantSourcesError
from schemas import ComparisonDraft, ComparisonFinding, SourceComparisonRequest


def finding(category="agreement", left=None, right=None):
    return ComparisonFinding(category=category, topic="Learning", left="Left claim", right="Right claim",
                             left_citations=[1] if left is None else left,
                             right_citations=[2] if right is None else right)


def test_citations_must_come_from_the_corresponding_source():
    passages = [{"source_id": "a"}, {"source_id": "b"}]
    assert comparison.ground_findings([finding(left=[2], right=[1]), finding(left=[999])], passages, ["a", "b"]) == []
    assert len(comparison.ground_findings([finding()], passages, ["a", "b"])) == 1


def test_gaps_are_one_sided_and_absence_is_limited_to_reviewed_passages():
    passages = [{"source_id": "a"}, {"source_id": "b"}]
    result = comparison.ground_findings([finding("gap", right=[]), finding("gap"), finding("gap", left=[], right=[])], passages, ["a", "b"])
    assert len(result) == 1
    assert result[0].right == comparison.MISSING


class Connection:
    def __init__(self, missing=False):
        self.calls = []
        self.missing = missing

    async def fetch(self, sql, workspace, source, limit):
        self.calls.append((sql, workspace, source, limit))
        if self.missing and source == "b":
            return []
        return [{"source_id": source, "source_name": source + ".pdf", "chunk_index": 0,
                 "content": "Evidence " * 1000, "page_number": 1, "location_label": "Page 1", "total_passages": 20}]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class Pool:
    def __init__(self, missing=False):
        self.conn = Connection(missing)

    def acquire(self):
        return self.conn


def test_balanced_sampling_scopes_every_query_and_uses_real_citation_metadata(monkeypatch):
    pool = Pool()
    seen = []

    async def generate(*args, **kwargs):
        seen.append((args, kwargs))
        return ComparisonDraft(findings=[finding()])

    monkeypatch.setattr(comparison, "_generate_json", generate)
    result = asyncio.run(comparison.compare_sources(pool, SourceComparisonRequest(
        workspace_id="workspace", user_id="user", source_ids=["a", "b"], focus="methods")))
    assert [(c[1], c[2]) for c in pool.conn.calls] == [("workspace", "a"), ("workspace", "b")]
    assert all("workspace_id = $1 AND source_id = $2" in c[0] for c in pool.conn.calls)
    assert [c.source_name for c in result.citations] == ["a.pdf", "b.pdf"]
    assert all(c.sampled for c in result.coverage)
    assert seen[0][1]["user_id"] == "user"
    assert "UNTRUSTED" in seen[0][0][5]
    assert len(result.findings) == 1


def test_missing_source_does_not_call_the_model(monkeypatch):
    async def must_not_call(*args, **kwargs):
        pytest.fail("Model should not be called without both sources")
    monkeypatch.setattr(comparison, "_generate_json", must_not_call)
    with pytest.raises(NoRelevantSourcesError):
        asyncio.run(comparison.compare_sources(Pool(missing=True), SourceComparisonRequest(workspace_id="ws", source_ids=["a", "b"])))
