"""
schemas.py — All Pydantic request/response models for the AI service.
"""

from pydantic import BaseModel, Field, HttpUrl
from typing import Annotated, Literal, Optional

# Bounds on every client-controlled field: they cap prompt size (cost) and reject junk early.
Id = Annotated[str, Field(min_length=1, max_length=64)]
ShortText = Annotated[str, Field(min_length=1, max_length=500)]


# ── Embed endpoint ────────────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    workspace_id: Id
    source_id: Id
    storage_url: Annotated[str, Field(min_length=1, max_length=2200)]


class EmbedResponse(BaseModel):
    source_id: str
    chunks_stored: int


# ── Summarize endpoint ────────────────────────────────────────────────────────

class SummarizeRequest(BaseModel):
    workspace_id: Id
    user_id: Optional[Id] = None  # usage accounting only; set by the backend
    source_id: Id


class SummarizeResponse(BaseModel):
    source_id: str
    source_name: str
    summary: str
    key_takeaways: list[str]
    word_count: int


# ── Chat endpoint ─────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: Annotated[str, Field(max_length=8000)]


class ChatRequest(BaseModel):
    workspace_id: Id
    message: Annotated[str, Field(min_length=1, max_length=8000)]
    conversation_history: Annotated[list[ChatMessage], Field(max_length=40)] = []
    # Optional: authenticated user (for usage accounting only; authorization is
    # the backend's job), document-level constraint, and explicit task routing.
    user_id: Optional[Id] = None
    source_ids: Optional[Annotated[list[Id], Field(max_length=50)]] = None
    task: Optional[Literal["chat", "study", "research"]] = None


class GeneralChatRequest(BaseModel):
    """One question sent to the general model on purpose. No documents, no history."""
    workspace_id: Id
    message: Annotated[str, Field(min_length=1, max_length=8000)]
    user_id: Optional[Id] = None


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
    # grounded | uncited | no_sources | no_answer | general
    grounding: str = "grounded"
    warnings: list[str] = []
    task: Optional[str] = None
    route: Optional[RouteInfo] = None  # None when no model was called
    usage: Optional[UsageInfo] = None


# ── Agent endpoints (Study Coach) ─────────────────────────────────────────────

class StudyCoachRequest(BaseModel):
    workspace_id: Id
    user_id: Id
    goal: Annotated[str, Field(min_length=1, max_length=2000)]


class StudyCoachResponse(BaseModel):
    run_id: str


class AgentStatusResponse(BaseModel):
    run_id: str
    status: str
    plan: Optional[str] = None
    materials: Optional[str] = None


# ── Studio endpoints (Content Generation) ─────────────────────────────────────

class FlashcardRequest(BaseModel):
    workspace_id: Id
    user_id: Optional[Id] = None  # usage accounting only; set by the backend
    topic: Optional[Annotated[str, Field(max_length=500)]] = None
    count: Annotated[int, Field(ge=1, le=50)] = 20

class FlashcardItem(BaseModel):
    front: str
    back: str
    source_ref: str

class FlashcardsResponse(BaseModel):
    flashcards: list[FlashcardItem]


class QuizRequest(BaseModel):
    workspace_id: Id
    user_id: Optional[Id] = None  # usage accounting only; set by the backend
    topic: ShortText
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    count: Annotated[int, Field(ge=1, le=30)] = 10

class QuizQuestion(BaseModel):
    question: str
    options: list[str]
    correct: str
    explanation: str
    source_ref: str

class QuizResponse(BaseModel):
    questions: list[QuizQuestion]


class StudyGuideRequest(BaseModel):
    workspace_id: Id
    user_id: Optional[Id] = None  # usage accounting only; set by the backend
    topic: ShortText

class StudyGuideSection(BaseModel):
    heading: str
    content: str
    key_terms: list[str]

class StudyGuideResponse(BaseModel):
    title: str
    sections: list[StudyGuideSection]


class ReportRequest(BaseModel):
    workspace_id: Id
    user_id: Optional[Id] = None  # usage accounting only; set by the backend
    title: ShortText
    outline_points: Annotated[list[ShortText], Field(max_length=30)]

class ReportResponse(BaseModel):
    report_markdown: str
