"""Balanced, source-scoped document comparison. Citation metadata comes only from indexed passages."""
from llm.types import Task
from rag import grounding
from rag.generator import NoRelevantSourcesError, _generate_json
from schemas import (SourceComparisonRequest, SourceComparisonResponse, ComparisonDraft,
                     ComparisonCoverage)

PASSAGES_PER_SOURCE = 12
CHARS_PER_SOURCE = 18000
MISSING = "Not covered in the reviewed passages."


def ground_findings(findings, passages, source_ids):
    """Require evidence from each corresponding source; a one-sided gap never claims whole-document absence."""
    valid = []
    for finding in findings:
        for side, source_id in zip(("left", "right"), source_ids):
            refs = getattr(finding, f"{side}_citations")
            refs = list(dict.fromkeys(n for n in refs if 1 <= n <= len(passages)
                                     and passages[n - 1]["source_id"] == source_id))
            setattr(finding, f"{side}_citations", refs)
        left, right = finding.left_citations, finding.right_citations
        if finding.category in ("agreement", "contradiction") and not (left and right):
            continue
        if finding.category == "gap":
            if bool(left) == bool(right):
                continue
            if not left:
                finding.left = MISSING
            if not right:
                finding.right = MISSING
        if not finding.left.strip() or not finding.right.strip():
            continue
        valid.append(finding)
    return valid


async def compare_sources(pool, request: SourceComparisonRequest) -> SourceComparisonResponse:
    if len(set(request.source_ids)) != 2:
        raise NoRelevantSourcesError("Choose two different sources.")
    passages, coverage = [], []
    for source_id in request.source_ids:
        # Equal buckets cover the document rather than only its opening. The same number and
        # character budget per source prevents a large document crowding the other one out.
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT * FROM (
                   SELECT sc.source_id::text AS source_id, sc.chunk_index, sc.content, sc.page_number,
                     sc.location_label, s.name AS source_name, COUNT(*) OVER () AS total_passages,
                     ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY sc.chunk_index) AS pick
                   FROM (
                     SELECT *, ntile($3::int) OVER (ORDER BY chunk_index) AS bucket
                     FROM source_chunks WHERE workspace_id = $1 AND source_id = $2
                   ) sc JOIN sources s ON s.id = sc.source_id AND s.workspace_id = sc.workspace_id
                   WHERE s.status = 'ready'
                ) candidates WHERE pick = 1 ORDER BY chunk_index""",
                request.workspace_id, source_id, PASSAGES_PER_SOURCE,
            )
        if not rows:
            raise NoRelevantSourcesError("Both sources need indexed passages before comparison.")
        used, selected, shortened = 0, [], False
        for row in rows:
            chunk = dict(row)
            remaining = CHARS_PER_SOURCE - used
            if remaining <= 0:
                break
            content = chunk["content"][:min(2500, remaining)]
            shortened = shortened or len(content) < len(chunk["content"])
            selected.append({**chunk, "content": content})
            used += len(content)
        passages.extend(selected)
        coverage.append(ComparisonCoverage(
            source_id=source_id, source_name=rows[0]["source_name"], reviewed_passages=len(selected),
            total_passages=rows[0]["total_passages"],
            sampled=shortened or len(selected) < rows[0]["total_passages"],
        ))
    context = "\n\n".join(
        f"[{i}] {'LEFT' if p['source_id'] == request.source_ids[0] else 'RIGHT'} | "
        f"{p['source_name']} | {p.get('location_label') or 'Passage ' + str(p['chunk_index'] + 1)}\n{p['content']}"
        for i, p in enumerate(passages, 1)
    )
    draft = await _generate_json(
        pool, request.workspace_id, "source_comparison", Task.RESEARCH,
        "Compare only these two documents using the supplied passages. Return JSON with findings, at most 18. "
        "Each finding has category (agreement, contradiction, gap), topic, left, right, left_citations "
        "and right_citations (arrays of passage numbers). Statements must be supported by cited passages "
        "from the matching LEFT or RIGHT document. For agreements and contradictions cite both sides. "
        "A contradiction means incompatible claims about the same conditions, not merely different topics. "
        "For a gap cite exactly one side; leave the other citation array empty. Absence means only absent "
        "from the reviewed passages, never from the entire document. Do not invent findings to fill a category. "
        "Use plain text in the fields, not citation markers or links. Return {\"findings\": []} if nothing is supported.",
        grounding.fence("COMPARISON FOCUS", request.focus or "Main themes, evidence, methods and conclusions")
        + "\n\n" + grounding.fence("DOCUMENT PASSAGES", context), ComparisonDraft,
        user_id=request.user_id,
    )
    findings = ground_findings(draft.findings, passages, request.source_ids)
    warnings = ["AI findings need review against the cited passages. Gaps refer only to the passages reviewed."]
    if any(c.sampled for c in coverage):
        warnings.append("This comparison uses a bounded sample; some document content was not reviewed.")
    if len(findings) < len(draft.findings):
        warnings.append("Some findings were withheld because they lacked valid citations for the corresponding sources.")
    return SourceComparisonResponse(
        findings=findings, citations=[grounding.citation_for(i, p) for i, p in enumerate(passages, 1)],
        coverage=coverage, warnings=warnings,
    )
