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


class Citation(BaseModel):
    source_name: str
    page_number: Optional[int] = None
    chunk_index: int
    excerpt: Optional[str] = None


class ChatResponse(BaseModel):
    answer: str
    citations: list[Citation]


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
    plan: Optional[str] = None
    materials: Optional[str] = None


# ── Studio endpoints (Content Generation) ─────────────────────────────────────

class FlashcardRequest(BaseModel):
    workspace_id: str
    topic: Optional[str] = None
    count: int = 20

class FlashcardItem(BaseModel):
    front: str
    back: str
    source_ref: str

class FlashcardsResponse(BaseModel):
    flashcards: list[FlashcardItem]


class QuizRequest(BaseModel):
    workspace_id: str
    topic: str
    difficulty: str = "medium"
    count: int = 10

class QuizQuestion(BaseModel):
    question: str
    options: list[str]
    correct: str
    explanation: str
    source_ref: str

class QuizResponse(BaseModel):
    questions: list[QuizQuestion]


class StudyGuideRequest(BaseModel):
    workspace_id: str
    topic: str

class StudyGuideSection(BaseModel):
    heading: str
    content: str
    key_terms: list[str]

class StudyGuideResponse(BaseModel):
    title: str
    sections: list[StudyGuideSection]


class ReportRequest(BaseModel):
    workspace_id: str
    title: str
    outline_points: list[str]

class ReportResponse(BaseModel):
    report_markdown: str
