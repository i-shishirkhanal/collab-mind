"""
main.py — FastAPI application entry point for the CollabMind AI service.
"""

import json
import logging
import asyncio
import os
from contextlib import asynccontextmanager
from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.responses import JSONResponse, StreamingResponse
import uuid

from security import load_service_token, require_service_auth

from config import ConfigError, get_settings
from llm import errors as llm_errors
from llm.redaction import install_log_redaction
from llm.types import Task
from redis_client import get_redis, close_redis
from db import get_pool, close_pool, ensure_schema
from schemas import (
    EmbedRequest, EmbedResponse,
    SummarizeRequest, SummarizeResponse,
    ChatRequest, GeneralChatRequest, ChatResponse, RouteInfo, UsageInfo, Faithfulness, UnsupportedClaim,
    StudyCoachRequest, StudyCoachResponse,
    AgentRunRequest, AgentStatusResponse,
    FlashcardRequest, FlashcardsResponse,
    QuizRequest, QuizResponse,
    StudyGuideRequest, StudyGuideResponse,
    ReportRequest, ReportResponse,
    WhiteboardRequest, WhiteboardResponse,
)
from rag.embedder import embed_source
from rag.pipeline import RagResult, run_rag_pipeline, stream_rag_pipeline
from rag import generator, grounding
from rag.usage import record_usage
from llm import get_router
from agents.study_coach import StudyCoachAgent
from agents.reaper import reaper_loop
from agents.runner import run_study_coach_background
from agents.engine import RunContext, run_agent
from agents.registry import AGENTS

log = logging.getLogger("collabmind.ai")


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_service_token()  # refuse to start without a strong AI_SERVICE_TOKEN

    install_log_redaction()
    settings = get_settings()  # ConfigError here aborts startup with a clear message
    for problem in settings.validate_for_serving():
        log.warning(problem)

    await get_redis()
    pool = await get_pool()
    await ensure_schema(pool)

    app.state.study_coach = StudyCoachAgent(pool)
    reaper = asyncio.create_task(reaper_loop(pool))

    yield

    reaper.cancel()
    await asyncio.gather(reaper, return_exceptions=True)
    await close_pool()
    await close_redis()


_docs_enabled = os.environ.get("AI_ENABLE_DOCS", "").lower() == "true"

app = FastAPI(
    title="CollabMind AI — AI Service",
    description="RAG pipeline and agent endpoints for CollabMind AI.",
    version="1.0.0",
    lifespan=lifespan,
    # Every route except /health requires the backend's service token.
    dependencies=[Depends(require_service_auth)],
    # Interactive docs are unauthenticated, so they are off unless explicitly enabled.
    docs_url="/docs" if _docs_enabled else None,
    redoc_url=None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)


# ── Error mapping: typed failures -> honest status codes, safe messages ───────

def _error_response(status: int, code: str, message: str, retry_after: float | None = None) -> JSONResponse:
    headers = {"Retry-After": str(int(retry_after))} if retry_after else None
    return JSONResponse(status_code=status, content={"detail": message, "code": code}, headers=headers)


@app.exception_handler(llm_errors.ProviderError)
async def provider_error_handler(_: Request, exc: llm_errors.ProviderError):
    log.warning("provider error %s provider=%s model=%s upstream=%s",
                exc.code, exc.provider, exc.model, exc.upstream_status)
    return _error_response(exc.http_status, exc.code, str(exc), exc.retry_after)


@app.exception_handler(generator.NoRelevantSourcesError)
async def no_sources_handler(_: Request, exc: generator.NoRelevantSourcesError):
    return _error_response(404, "no_relevant_sources", str(exc))


@app.exception_handler(ConfigError)
async def config_error_handler(_: Request, exc: ConfigError):
    log.error("configuration error: %s", exc)
    return _error_response(503, "not_configured", "The AI service is not configured correctly.")


@app.post("/embed", response_model=EmbedResponse, summary="Embed a source document into pgvector")
async def embed_endpoint(body: EmbedRequest) -> EmbedResponse:
    pool = await get_pool()
    chunks_stored = await embed_source(
        pool=pool,
        workspace_id=body.workspace_id,
        source_id=body.source_id,
        storage_url=body.storage_url,
    )
    return EmbedResponse(source_id=body.source_id, chunks_stored=chunks_stored)


@app.post("/sources/summarize", response_model=SummarizeResponse, summary="Summarize a specific source document")
async def summarize_source_endpoint(body: SummarizeRequest) -> SummarizeResponse:
    pool = await get_pool()
    return await generator.summarize_source(pool, body)


def _to_response(result: RagResult) -> ChatResponse:
    return ChatResponse(
        answer=result.answer,
        citations=result.citations,
        grounding=result.grounding,
        warnings=result.warnings,
        task=result.task.value if result.task else None,
        route=RouteInfo(**result.route.to_dict()) if result.route else None,
        usage=UsageInfo(**result.usage.to_dict()) if result.usage else None,
        faithfulness=(Faithfulness(
            score=result.faithfulness.score, claims_checked=result.faithfulness.claims_checked,
            latency_ms=result.faithfulness.latency_ms,
            unsupported=[UnsupportedClaim(text=v.text, supported_probability=round(v.supported_probability, 4),
                                          cited=v.cited) for v in result.faithfulness.unsupported],
        ) if result.faithfulness else None),
    )


def _rag_kwargs(body: ChatRequest) -> dict:
    return dict(
        workspace_id=body.workspace_id,
        message=body.message,
        conversation_history=[m.model_dump() for m in body.conversation_history],
        source_ids=body.source_ids,
        task=Task(body.task) if body.task else None,
        user_id=body.user_id,
    )


@app.post("/chat", response_model=ChatResponse, summary="Answer a question using workspace RAG")
async def chat_endpoint(body: ChatRequest) -> ChatResponse:
    pool = await get_pool()
    return _to_response(await run_rag_pipeline(pool=pool, **_rag_kwargs(body)))


@app.post("/chat/general", response_model=ChatResponse,
          summary="Answer ONE question with the general model, outside the workspace sources")
async def chat_general_endpoint(body: GeneralChatRequest) -> ChatResponse:
    """Only reachable when the user explicitly asks for it. No retrieval and no conversation history,
    so nothing from the documents or earlier turns mixes into the answer."""
    pool = await get_pool()
    completion = await get_router().complete(
        Task.CHAT,
        [{"role": "system", "content": grounding.GENERAL_SYSTEM_PROMPT},
         {"role": "user", "content": body.message}],
        temperature=0.3,
    )
    await record_usage(pool, workspace_id=body.workspace_id, user_id=body.user_id, kind="general_chat",
                       task=Task.CHAT.value, route=completion.route, usage=completion.usage)
    return ChatResponse(
        answer=completion.text.strip(), citations=[], grounding="general",
        warnings=["General AI answer. It is not based on your uploaded sources."],
        task=Task.CHAT.value, route=RouteInfo(**completion.route.to_dict()),
        usage=UsageInfo(**completion.usage.to_dict()),
    )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/chat/stream", summary="Stream a RAG answer as server-sent events")
async def chat_stream_endpoint(body: ChatRequest):
    """Events: `delta` {text} ... then one `result` (the full ChatResponse, with
    citations resolved against retrieved chunks) or one `error` {code, message}.
    Failures before the first byte (retrieval, embeddings, provider) are normal
    HTTP errors, not events."""
    pool = await get_pool()
    gen = stream_rag_pipeline(pool=pool, **_rag_kwargs(body))
    first = await gen.__anext__()  # raises typed errors -> proper HTTP status

    async def events():
        try:
            item = first
            while True:
                kind, payload = item
                if kind == "delta":
                    yield _sse("delta", {"text": payload})
                else:
                    yield _sse("result", _to_response(payload).model_dump())
                item = await gen.__anext__()
        except StopAsyncIteration:
            return
        except llm_errors.ProviderError as exc:
            yield _sse("error", {"code": exc.code, "message": str(exc)})
        except Exception:  # noqa: BLE001
            log.exception("stream failed")
            yield _sse("error", {"code": "internal_error", "message": "The answer could not be completed."})

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/health", summary="Health check")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/models", summary="Active model routing and retrieval configuration (no secrets)")
async def models() -> dict:
    s = get_settings()
    return {
        "chat_and_study": {"provider": "deepseek", "model": s.llm.model_flash, "thinking": s.llm.flash_thinking},
        "research": {"provider": "deepseek", "model": s.llm.model_pro, "thinking": s.llm.pro_thinking},
        "fallback_pro_to_flash": s.llm.fallback_pro_to_flash,
        "auto_route_research": s.llm.auto_route_research,
        "llm_configured": bool(s.llm.api_key),
        "embedding": {"model": s.embedding.model, "dimensions": s.embedding.dimensions,
                      "configured": bool(s.embedding.base_url)},
        "retrieval": {"top_k": s.retrieval.top_k, "min_similarity": s.retrieval.min_similarity,
                      "hybrid": s.retrieval.hybrid},
    }


@app.post("/agents/study-coach", response_model=StudyCoachResponse)
async def trigger_study_coach(
    body: StudyCoachRequest,
    background_tasks: BackgroundTasks
) -> StudyCoachResponse:
    run_id = str(uuid.uuid4())
    pool = await get_pool()

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO agent_runs (id, workspace_id, agent_type, status, result)
            VALUES ($1, $2, 'study_coach', 'started', '{}')
            """,
            run_id, body.workspace_id
        )

    background_tasks.add_task(
        run_study_coach_background,
        run_id=run_id,
        workspace_id=body.workspace_id,
        user_id=body.user_id,
        goal=body.goal,
        pool=pool,
    )

    return StudyCoachResponse(run_id=run_id)


@app.post("/agents/{run_id}/approve", summary="Resume an awaiting agent run")
async def approve_study_plan(run_id: str) -> dict:
    redis_client = await get_redis()
    approval_key = f"approved:{run_id}"
    await redis_client.set(approval_key, "1", ex=300)
    return {"ok": True, "message": f"Approved run {run_id}. Graph resuming..."}


@app.post("/agents/run", response_model=StudyCoachResponse, summary="Start a specialist agent run")
async def run_specialist_agent(body: AgentRunRequest, background_tasks: BackgroundTasks) -> StudyCoachResponse:
    spec = AGENTS.get(body.agent)
    if spec is None:
        raise HTTPException(status_code=404, detail="Unknown agent.")
    pool = await get_pool()
    run_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        # One live run per workspace and agent: each run is several model calls.
        busy = await conn.fetchval(
            "SELECT 1 FROM agent_runs WHERE workspace_id = $1 AND agent_type = $2 "
            "AND status NOT IN ('completed', 'failed', 'rejected') "
            "AND created_at > NOW() - make_interval(mins => 30) LIMIT 1",
            body.workspace_id, spec.key,
        )
        if busy:
            raise HTTPException(status_code=409, detail=f"A {spec.title} run is already in progress in this workspace.")
        await conn.execute(
            "INSERT INTO agent_runs (id, workspace_id, user_id, agent_type, status, goal, result) "
            "VALUES ($1, $2, $3, $4, 'running', $5, '{}')",
            run_id, body.workspace_id, body.user_id, spec.key, body.goal,
        )
    ctx = RunContext(pool=pool, workspace_id=body.workspace_id, user_id=body.user_id, run_id=run_id)
    background_tasks.add_task(run_agent, spec, ctx, body.goal)
    return StudyCoachResponse(run_id=run_id)


@app.post("/agents/{run_id}/reject", summary="Decline an agent's approval checkpoint")
async def reject_agent_plan(run_id: str) -> dict:
    redis_client = await get_redis()
    await redis_client.set(f"rejected:{run_id}", "1", ex=300)
    return {"ok": True}


@app.get("/agents/{run_id}/status", response_model=AgentStatusResponse)
async def get_agent_status(run_id: str) -> AgentStatusResponse:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status, result, agent_type, goal, step_count FROM agent_runs WHERE id = $1",
            run_id
        )

    if not row:
        raise HTTPException(status_code=404, detail="Run not found.")

    try:
        result_dict = json.loads(row["result"])
    except Exception:
        result_dict = {}

    return AgentStatusResponse(
        run_id=run_id,
        status=row["status"],
        plan=result_dict.get("plan"),
        materials=result_dict.get("materials"),
        agent_type=row["agent_type"],
        goal=row["goal"],
        step_count=row["step_count"] or 0,
        answer=result_dict.get("answer"),
        citations=result_dict.get("citations") or [],
        warnings=result_dict.get("warnings") or [],
        message=result_dict.get("message"),
        pending_approval=result_dict.get("pending_approval"),
    )


@app.post("/studio/flashcards", response_model=FlashcardsResponse, summary="Generate flashcards")
async def create_flashcards(body: FlashcardRequest) -> FlashcardsResponse:
    return await generator.generate_flashcards(await get_pool(), body)


@app.post("/studio/quiz", response_model=QuizResponse, summary="Generate a quiz")
async def create_quiz(body: QuizRequest) -> QuizResponse:
    return await generator.generate_quiz(await get_pool(), body)


@app.post("/studio/study-guide", response_model=StudyGuideResponse, summary="Generate study guide")
async def create_study_guide(body: StudyGuideRequest) -> StudyGuideResponse:
    return await generator.generate_study_guide(await get_pool(), body)


@app.post("/studio/whiteboard", response_model=WhiteboardResponse, summary="Generate a mind map for the whiteboard")
async def create_whiteboard(body: WhiteboardRequest) -> WhiteboardResponse:
    return await generator.generate_whiteboard(await get_pool(), body)


@app.post("/studio/report", response_model=ReportResponse, summary="Generate markdown report")
async def create_report(body: ReportRequest) -> ReportResponse:
    return await generator.generate_report(await get_pool(), body)
