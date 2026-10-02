"""
schemas.py — All Pydantic request/response models for the AI service.
"""

from pydantic import BaseModel, HttpUrl
from typing import Optional


# ── Embed endpoint ────────────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    workspace_id: str
    source_id: str
    storage_url: str


class EmbedResponse(BaseModel):
    source_id: str
    chunks_stored: int


# ── Summarize endpoint ────────────────────────────────────────────────────────

class SummarizeRequest(BaseModel):
    workspace_id: str
    source_id: str


class SummarizeResponse(BaseModel):
    source_id: str
    source_name: str
    summary: str
    key_takeaways: list[str]
    word_count: int


# ── Chat endpoint ─────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    workspace_id: str
    message: str
    conversation_history: list[ChatMessage] = []
    # Optional: authenticated user (for usage accounting only; authorization is
    # the backend's job), document-level constraint, and explicit task routing.
    user_id: Optional[str] = None
    source_ids: Optional[list[str]] = None
    task: Optional[Literal["chat", "study", "research"]] = None


class Citation(BaseModel):
    # `index` is the [n] marker used in the answer text. Everything else is
    # copied from the retrieved chunk, never from model output.
    index: Optional[int] = None
    source_id: Optional[str] = None
    source_name: str
    page_number: Optional[int] = None
    chunk_index: int
    excerpt: Optional[str] = None
    location_label: Optional[str] = None
    similarity: Optional[float] = None


class RouteInfo(BaseModel):
    provider: str
    tier: str
    model_requested: str
    model_used: str
    attempts: int
    fallback_used: bool
    fallback_reason: Optional[str] = None
    latency_ms: int


class UsageInfo(BaseModel):
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    reasoning_tokens: Optional[int] = None


class ChatResponse(BaseModel):
    answer: str
    citations: list[Citation]
    # grounded | uncited | no_sources | no_answer
    grounding: str = "grounded"
    warnings: list[str] = []
    task: Optional[str] = None
    route: Optional[RouteInfo] = None  # None when no model was called
    usage: Optional[UsageInfo] = None


# ── Agent endpoints (Study Coach) ─────────────────────────────────────────────

class StudyCoachRequest(BaseModel):
    workspace_id: str
    user_id: str
    goal: str


class StudyCoachResponse(BaseModel):
    run_id: str


class AgentStatusResponse(BaseModel):
    run_id: str
    status: str
    plan: Optional[str] = N