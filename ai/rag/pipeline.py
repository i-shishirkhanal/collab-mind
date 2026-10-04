"""
rag/pipeline.py — Workspace-scoped retrieval-augmented answering.

    retrieve (BGE-M3 + FTS, workspace-filtered, thresholded)
      -> no relevant chunks?  return NO_SOURCES answer, call NO model
      -> route task (Flash / Pro) and generate with a grounded prompt
      -> resolve [n] markers to the real retrieved chunks
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import AsyncIterator, Optional

import asyncpg

from config import get_settings
from llm import get_router
from llm.router import classify_task
from llm.types import Completion, Route, StreamEvent, Task, Usage
from rag import grounding
from rag.grounding import NO_ANSWER, Grounded, build_messages, citation_for, select_passages
from rag.reranker import candidates_needed, rerank_chunks
from rag.retriever import retrieve_chunks
from rag.usage import record_usage
from rag.verifier import Faithfulness, verify_answer
from schemas import Citation

NO_SOURCES_ANSWER = NO_ANSWER


@dataclass
class RagResult:
    answer: str
    citations: list[Citation]
    grounding: str
    warnings: list[str] = field(default_factory=list)
    task: Optional[Task] = None
    route: Optional[Route] = None
    usage: Optional[Usage] = None
    faithfulness: Optional[Faithfulness] = None


@dataclass
class Prepared:
    """Retrieval done; either an immediate result (nothing relevant) or the
    messages to send to the model."""

    early: Optional[RagResult] = None
    messages: Optional[list[dict]] = None
    passages: Optional[list[dict]] = None
    task: Optional[Task] = None


def _extract_citations(chunks: list[dict]) -> list[Citation]:
    """Citations for a list of chunks, numbered from 1 (kept for callers/tests)."""
    return [citation_for(i, c) for i, c in enumerate(chunks, start=1)]


async def prepare(
    pool: asyncpg.Pool,
    workspace_id: str,
    message: str,
    conversation_history: list[dict],
    *,
    source_ids: Optional[list[str]] = None,
    task: Optional[Task] = None,
) -> Prepared:
    cfg = get_settings()
    chosen_task = classify_task(message, task, auto_research=cfg.llm.auto_route_research)
    # Research questions get a wider net than ordinary chat.
    top_k = cfg.retrieval.top_k * (2 if chosen_task is Task.RESEARCH else 1)
    chunks = await retrieve_chunks(pool, workspace_id, message,
                                   top_k=candidates_needed(cfg.retrieval, top_k), source_ids=source_ids)
    chunks, _ = await rerank_chunks(cfg.retrieval, message, chunks, top_k)   # no-op unless RERANKER_ENABLED
    if not chunks:
        return Prepared(early=RagResult(
            answer=NO_SOURCES_ANSWER, citations=[], grounding="no_sources", task=chosen_task,
            warnings=["No sufficiently relevant passages were found in the workspace sources."],
        ))
    passages = select_passages(chunks, cfg.retrieval.context_max_chars)
    return Prepared(
        messages=build_messages(message, passages, conversation_history),
        passages=passages, task=chosen_task,
    )


def _finish(prep: Prepared, completion_text: str, route: Route, usage: Usage) -> RagResult:
    g: Grounded = grounding.resolve_citations(completion_text, prep.passages or [])
    return RagResult(answer=g.answer, citations=g.citations, grounding=g.grounding,
                     warnings=g.warnings, task=prep.task, route=route, usage=usage)


async def _verified(result: RagResult, passages: Optional[list[dict]]) -> RagResult:
    """Attach the faithfulness check (a no-op unless VERIFIER_ENABLED; never raises)."""
    if result.grounding == "grounded":
        result.faithfulness = await verify_answer(get_settings().verifier, result.answer, passages or [])
    return result


async def run_rag_pipeline(
    pool: asyncpg.Pool,
    workspace_id: str,
    message: str,
    conversation_history: list[dict],
    *,
    source_ids: Optional[list[str]] = None,
    task: Optional[Task] = None,
    user_id: Optional[str] = None,
) -> RagResult:
    prep = await prepare(pool, workspace_id, message, conversation_history,
                         source_ids=source_ids, task=task)
    if prep.early:
        return prep.early
    completion: Completion = await get_router().complete(prep.task, prep.messages, temperature=0.1)
    result = await _verified(_finish(prep, completion.text, completion.route, completion.usage), prep.passages)
    await record_usage(pool, workspace_id=workspace_id, user_id=user_id, kind="chat",
                       task=prep.task.value, route=completion.route, usage=completion.usage)
    return result


async def stream_rag_pipeline(
    pool: asyncpg.Pool,
    workspace_id: str,
    message: str,
    conversation_history: list[dict],
    *,
    source_ids: Optional[list[str]] = None,
    task: Optional[Task] = None,
    user_id: Optional[str] = None,
) -> AsyncIterator[tuple[str, object]]:
    """Yields ('delta', text) pieces then one ('result', RagResult). The result
    carries the authoritative, citation-resolved answer; streamed deltas are a
    preview and may include markers the final answer strips."""
    prep = await prepare(pool, workspace_id, message, conversation_history,
                         source_ids=source_ids, task=task)
    if prep.early:
        yield "result", prep.early
        return
    parts: list[str] = []
    done: Optional[StreamEvent] = None
    async for ev in get_router().stream(prep.task, prep.messages, temperature=0.1):
        if ev.kind == "delta":
            parts.append(ev.text)
            yield "delta", ev.text
        else:
            done = ev
    assert done is not None and done.route is not None
    usage = done.usage or Usage()
    await record_usage(pool, workspace_id=workspace_id, user_id=user_id, kind="chat",
                       task=prep.task.value, route=done.route, usage=usage)
    yield "result", await _verified(_finish(prep, "".join(parts), done.route, usage), prep.passages)
