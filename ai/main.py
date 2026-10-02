"""
main.py — FastAPI application entry point for the CollabMind AI service.
"""

import os
from contextlib import asynccontextmanager
from dotenv import load_dotenv

load_dotenv()

import google.generativeai as genai
from fastapi import FastAPI, HTTPException, BackgroundTasks
import uuid

from redis_client import get_redis, close_redis
from db import get_pool, close_pool, ensure_schema
from schemas import (
    EmbedRequest, EmbedResponse,
    SummarizeRequest, SummarizeResponse,
    ChatRequest, ChatResponse,
    StudyCoachRequest, StudyCoachResponse,
    AgentStatusResponse,
    FlashcardRequest, FlashcardsResponse,
    QuizRequest, QuizResponse,
    StudyGuideRequest, StudyGuideResponse,
    ReportRequest, ReportResponse,
)
from rag.embedder import embed_source
from rag.pipeline import run_rag_pipeline
from rag import generator
from agents.study_coach import StudyCoachAgent
from agents.runner import run_study_coach_background


@asynccontextmanager
async def lifespan(app: FastAPI):
    api_key = os.environ.get("GEMINI_API_KEY", "dummy_gemini_key_for_testing")
    genai.configure(api_key=api_key)

    await get_redis()
    pool = await get_pool()
    await ensure_schema(pool)

    app.state.study_coach = StudyCoachAgent(pool)

    yield

    await close_pool()
    await close_redis()


app = FastAPI(
    title="CollabMind AI — AI Service",
    description="RAG pipeline and agent endpoints for CollabMind AI.",
    version="1.0.0",
    lifespan=lifespan,
)


@app.post("/embed", response_model=EmbedResponse, summary="Embed a source document into pgvector")
async def embed_endpoint(body: EmbedRequest) -> EmbedResponse:
    pool = await get_pool()
    try:
        chunks_stored = await embed_source(
            pool=pool,
            workspace_id=body.workspace_id,
            source_id=body.source_id,
            storage_url=body.storage_url,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return EmbedResponse(
        source_id=body.source_id,
        chunks_stored=chunks_stored,
    )


@app.post("/sources/summarize", response_model=SummarizeResponse, summary="Summarize a specific source document")
async def summarize_source_endpoint(body: SummarizeRequest) -> SummarizeResponse:
    pool = await get_pool()
    try:
        return await generator.summarize_source(pool, body)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/chat", response_model=ChatResponse, summary="Answer a question using workspace RAG")
async def chat_endpoint(body: ChatRequest) -> ChatResponse:
    pool = await get_pool()
    history_dicts = [msg.model_dump() for msg in body.conversation_history]

    try:
        answer, citations = await run_rag_pipeline(
            pool=pool,
            workspace_id=body.workspace_id,
            message=body.message,
            conversation_history=history_dicts,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return ChatResponse(
        answer=answer,
        citations=citations,
    )


@app.get("/health", summary="Health check")
async def health() -> dict:
    return {"status": "ok"}


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


@app.get("/agents/{run_id}/status", response_model=AgentStatusResponse)
async def get_agent_status(run_id: str) -> AgentStatusResponse:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status, result FROM agent_runs WHERE id = $1", 
            run_id
        )
        
    if not row:
        raise HTTPException(status_code=404, detail="Run not found.")

    import json
    try:
        result_dict = json.loads(row["result"])
    except Exception:
        result_dict = {}

    return AgentStatusResponse(
        run_id=run_id,
        status=row["status"],
        plan=result_dict.get("plan"),
        materials=result_dict.get("materials"),
    )


@app.post("/studio/flashcards", response_model=FlashcardsResponse, summary="Generate flashcards")
async def create_flashcards(body: FlashcardRequest) -> FlashcardsResponse:
    pool = await get_pool()
    try:
        return await generator.generate_flashcards(pool, body)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/studio/quiz", response_model=QuizResponse, summary="Generate a quiz")
async def create_quiz(body: QuizRequest) -> QuizResponse:
    pool = await get_pool()
    try:
        return await generator.generate_quiz(pool, body)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/studio/study-guide", response_model=StudyGuideResponse, summary="Generate study guide")
async def create_study_guide(body: StudyGuideRequest) -> StudyGuideResponse:
    pool = await get_pool()
    try:
        return await generator.generate_study_guide(pool, body)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/studio/report", response_model=ReportResponse, summary="Generate markdown report")
async def create_report(body: ReportRequest) -> ReportResponse:
    pool = await get_pool()
    try:
        return await generator.generate_report(pool, body)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
