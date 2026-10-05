"""
rag/generator.py — Studio content generation (summary, flashcards, quiz, study
guide, report) over workspace sources, via the model router.

Ordinary study output runs on Flash; the long-form report runs on Pro. There is
no "extractive" fallback that pretends to be generated content: if the model or
embeddings are unavailable the call raises a typed error that the API turns
into an honest 503, and if the workspace has nothing relevant it raises
NoRelevantSourcesError.
"""

from __future__ import annotations

import json
from typing import Optional

import asyncpg
from pydantic import BaseModel, ValidationError

from llm import errors, get_router
from llm.types import Completion, Task
from rag import grounding
from rag.grounding import select_passages
from rag.retriever import retrieve_chunks, sample_chunks
from rag.usage import record_usage
from config import get_settings

from schemas import (
    FlashcardRequest, FlashcardsResponse,
    QuizRequest, QuizResponse,
    StudyGuideRequest, StudyGuideResponse,
    ReportRequest, ReportResponse,
    SummarizeRequest, SummarizeResponse,
    WhiteboardRequest, WhiteboardResponse,
)

SUMMARY_MAX_CHARS = 60_000
UNVERIFIED = "Unverified source"


class _SummaryShape(BaseModel):
    summary: str
    key_takeaways: list[str] = []


class NoRelevantSourcesError(Exception):
    """The workspace has no (sufficiently relevant) indexed content for this request."""


async def _get_context(pool: asyncpg.Pool, workspace_id: str, topic: Optional[str],
                       top_k: int = 25) -> tuple[str, list[dict]]:
    if topic and topic.strip():
        chunks = await retrieve_chunks(pool, workspace_id, topic, top_k=top_k)
    else:
        chunks = await sample_chunks(pool, workspace_id, top_k)
    if not chunks:
        raise NoRelevantSourcesError(
            "No relevant indexed content was found in this workspace for that request."
        )
    chunks = select_passages(chunks, get_settings().retrieval.context_max_chars)
    parts = []
    for i, c in enumerate(chunks, start=1):
        where = f" | {c['location_label']}" if c.get("location_label") else ""
        parts.append(f"[{i}] Source: {c['source_name']}{where}\n{c['content']}")
    return grounding.fence("WORKSPACE CONTEXT", "\n\n".join(parts)), chunks


def _parse_json(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    try:
        data = json.loads(cleaned)
    except ValueError:
        # Prose before the object, or junk/repeats after it (observed from a live gateway in JSON
        # mode: `{"ok": true}# Benchmark Output {"ok": true}…`): take the FIRST complete JSON object.
        start = cleaned.find("{")
        if start == -1:
            raise errors.MalformedResponseError("The model did not return valid JSON.") from None
        try:
            data, _ = json.JSONDecoder().raw_decode(cleaned[start:])
        except ValueError:
            raise errors.MalformedResponseError("The model did not return valid JSON.") from None
    if not isinstance(data, dict):
        raise errors.MalformedResponseError("The model returned JSON of the wrong shape.")
    return data


async def _generate_json(pool, workspace_id: str, kind: str, task: Task, system: str, user: str, model_cls,
                         user_id: Optional[str] = None):
    completion: Completion = await get_router().complete(
        task,
        [{"role": "system", "content": f"{system} {grounding.UNTRUSTED_RULE}"}, {"role": "user", "content": user}],
        json_mode=True, temperature=0.3,
    )
    await record_usage(pool, workspace_id=workspace_id, user_id=user_id, kind=kind, task=task.value,
                       route=completion.route, usage=completion.usage)
    try:
        return model_cls(**_parse_json(completion.text))
    except ValidationError:
        raise errors.MalformedResponseError(
            "The model's JSON did not match the expected structure.",
            provider=completion.route.provider, model=completion.route.model_used,
        ) from None


def _resolve_ref(ref: str, chunks: list[dict]) -> str:
    """source_ref must name a source that was actually in the context."""
    names = {c["source_name"] for c in chunks}
    if ref in names:
        return ref
    lowered = {n.lower(): n for n in names}
    if ref and ref.lower() in lowered:
        return lowered[ref.lower()]
    for n in names:  # tolerate "[2] paper.pdf" / "paper.pdf, p.3"
        if ref and n.lower() in ref.lower():
            return n
    return UNVERIFIED


_JSON_NOTE = "Respond with a single JSON object only, no prose, matching the schema exactly."


async def summarize_source(pool: asyncpg.Pool, request: SummarizeRequest) -> SummarizeResponse:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT sc.content, s.name AS source_name
            FROM source_chunks sc
            JOIN sources s ON s.id = sc.source_id AND s.workspace_id = sc.workspace_id
            WHERE sc.workspace_id = $1 AND sc.source_id = $2 AND s.status = 'ready'
            ORDER BY sc.chunk_index ASC
            """,
            request.workspace_id, request.source_id,
        )
    if not rows:
        raise NoRelevantSourcesError("This source has no indexed content to summarize.")

    source_name = rows[0]["source_name"]
    full_text = "\n".join(r["content"] for r in rows)
    truncated = len(full_text) > SUMMARY_MAX_CHARS
    system = ("You are a study assistant. Summarize ONLY what the document says; do not add outside "
              f"facts. {_JSON_NOTE}")
    user = (
        f"Document: '{source_name}'" + (" (truncated to its first part)" if truncated else "") +
        f"\n\n{grounding.fence('DOCUMENT', full_text[:SUMMARY_MAX_CHARS])}\n\n"
        'JSON schema: {"summary": "string", "key_takeaways": ["string"]}'
    )
    data = await _generate_json(pool, request.workspace_id, "summarize", Task.STUDY, system, user,
                                _SummaryShape, user_id=request.user_id)
    return SummarizeResponse(
        source_id=request.source_id, source_name=source_name, summary=data.summary,
        key_takeaways=data.key_takeaways, word_count=len(full_text.split()),
    )


async def generate_flashcards(pool: asyncpg.Pool, request: FlashcardRequest) -> FlashcardsResponse:
    context, chunks = await _get_context(pool, request.workspace_id, request.topic, top_k=30)
    system = ("You are a study assistant. Use ONLY the workspace context. Each flashcard's source_ref "
              f"must be the exact source name it came from. {_JSON_NOTE}")
    user = (
        f"Generate up to {request.count} flashcards from this context.\n\n{context}\n\n"
        'JSON schema: {"flashcards": [{"front": "string", "back": "string", "source_ref": "source name"}]}'
    )
    result = await _generate_json(pool, request.workspace_id, "flashcards", Task.STUDY, system, user,
                                  FlashcardsResponse, user_id=request.user_id)
    for card in result.flashcards:
        card.source_ref = _resolve_ref(card.source_ref, chunks)
    result.flashcards = result.flashcards[: request.count]
    return result


async def generate_quiz(pool: asyncpg.Pool, request: QuizRequest) -> QuizResponse:
    context, chunks = await _get_context(pool, request.workspace_id, request.topic, top_k=30)
    system = ("You are a test-prep instructor. Base every question and answer strictly on the "
              f"workspace context. source_ref must be the exact source name. {_JSON_NOTE}")
    user = (
        f"Write up to {request.count} multiple-choice questions on {json.dumps(request.topic)} at "
        f"{request.difficulty} difficulty. `correct` must equal one of the `options` verbatim.\n\n"
        f"{context}\n\n"
        'JSON schema: {"questions": [{"question": "string", "options": ["string"], '
        '"correct": "string", "explanation": "string", "source_ref": "source name"}]}'
    )
    result = await _generate_json(pool, request.workspace_id, "quiz", Task.STUDY, system, user, QuizResponse,
                                  user_id=request.user_id)
    valid = []
    for q in result.questions:
        if q.correct not in q.options:  # drop malformed items rather than ship a broken answer key
            continue
        q.source_ref = _resolve_ref(q.source_ref, chunks)
        valid.append(q)
    if not valid:
        raise errors.MalformedResponseError("The model produced no usable quiz questions.")
    result.questions = valid[: request.count]
    return result


async def generate_study_guide(pool: asyncpg.Pool, request: StudyGuideRequest) -> StudyGuideResponse:
    context, _ = await _get_context(pool, request.workspace_id, request.topic, top_k=30)
    system = f"You are a textbook author. Use only information in the workspace context. {_JSON_NOTE}"
    user = (
        f"Create a structured study guide for {json.dumps(request.topic)}.\n\n{context}\n\n"
        'JSON schema: {"title": "string", "sections": [{"heading": "string", "content": "string", '
        '"key_terms": ["string"]}]}'
    )
    return await _generate_json(pool, request.workspace_id, "study_guide", Task.STUDY, system, user,
                                StudyGuideResponse, user_id=request.user_id)


WB_MAX_DEPTH = 3
WB_LABEL_MAX = 60


def _clean_mind_map(nodes: list, max_nodes: int) -> list:
    """Keep one connected tree: a single root, known parents, no cycles, bounded depth and size.
    Anything that does not fit is dropped rather than repaired, so the board never shows a broken map."""
    by_id = {}
    for n in nodes:
        n.id, n.label = str(n.id).strip(), " ".join(n.label.split())[:WB_LABEL_MAX]
        if n.id and n.label and n.id not in by_id:
            by_id[n.id] = n
    roots = [n for n in by_id.values() if not n.parent]
    if not roots:
        return []
    root = roots[0]
    kept, depth = [root], {root.id: 0}
    pending = [n for n in by_id.values() if n is not root and n.parent]
    progressed = True
    while pending and progressed and len(kept) < max_nodes:  # parents may be listed after their children
        progressed, rest = False, []
        for n in pending:
            if n.parent in depth and depth[n.parent] < WB_MAX_DEPTH and len(kept) < max_nodes:
                depth[n.id] = depth[n.parent] + 1
                kept.append(n)
                progressed = True
            else:
                rest.append(n)
        pending = rest
    return kept


async def generate_whiteboard(pool: asyncpg.Pool, request: WhiteboardRequest) -> WhiteboardResponse:
    """A mind map outline (structure only, no coordinates; the client lays it out) grounded in the sources."""
    context, chunks = await _get_context(pool, request.workspace_id, request.topic, top_k=25)
    system = ("You turn workspace notes into a mind map. Use ONLY the workspace context; every node must "
              "be supported by it. Labels are short phrases (max 8 words). Exactly one root node has "
              "parent null; every other node's parent is the id of another node. Use at most 3 levels. "
              f"source_ref must be the exact source name a node came from. {_JSON_NOTE}")
    user = (
        f"Mind map of {json.dumps(request.topic)} with at most {request.max_nodes} nodes.\n\n{context}\n\n"
        'JSON schema: {"title": "string", "nodes": [{"id": "string", "label": "string", '
        '"parent": "id or null", "source_ref": "source name"}]}'
    )
    result = await _generate_json(pool, request.workspace_id, "whiteboard", Task.STUDY, system, user,
                                  WhiteboardResponse, user_id=request.user_id)
    nodes = _clean_mind_map(result.nodes, request.max_nodes)
    if len(nodes) < 2:
        raise errors.MalformedResponseError("The model produced no usable mind map.")
    for n in nodes:
        n.source_ref = _resolve_ref(n.source_ref, chunks)
    # Grounded only: a branch whose source is not in the retrieved context is dropped with its
    # descendants (parents always precede children in `nodes`). The root is just the topic heading.
    kept_ids = {nodes[0].id}
    grounded = [nodes[0]]
    for n in nodes[1:]:
        if n.parent in kept_ids and n.source_ref != UNVERIFIED:
            kept_ids.add(n.id)
            grounded.append(n)
    if len(grounded) < 2:
        raise NoRelevantSourcesError("The workspace sources do not cover that topic well enough to map it.")
    result.nodes = grounded
    result.title = " ".join(result.title.split())[:WB_LABEL_MAX] or request.topic[:WB_LABEL_MAX]
    return result


async def generate_report(pool: asyncpg.Pool, request: ReportRequest) -> ReportResponse:
    query = request.title + " " + " ".join(request.outline_points)
    context, chunks = await _get_context(pool, request.workspace_id, query, top_k=40)
    system = (
        "You are a research analyst writing a markdown report. Follow the outline exactly. Use ONLY the "
        "numbered workspace context; cite with [n] after each supported statement and never cite a number "
        "that does not exist. Where the sources do not cover an outline point, say so instead of filling in. "
        + grounding.UNTRUSTED_RULE
    )
    user = f"Title: {request.title}\nOutline: {json.dumps(request.outline_points)}\n\n{context}"
    completion = await get_router().complete(
        Task.RESEARCH,
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.3,
    )
    await record_usage(pool, workspace_id=request.workspace_id, user_id=request.user_id, kind="report",
                       task=Task.RESEARCH.value, route=completion.route, usage=completion.usage)
    resolved = grounding.resolve_citations(completion.text, chunks)
    lines = [resolved.answer.rstrip(), "", "## Sources", ""]
    for c in resolved.citations:
        where = f", {c.location_label}" if c.location_label else (f", page {c.page_number}" if c.page_number else "")
        lines.append(f"- [{c.index}] {c.source_name}{where}")
    if not resolved.citations:
        lines.append("_No source passages were cited in this report._")
    return ReportResponse(report_markdown="\n".join(lines) + "\n")
