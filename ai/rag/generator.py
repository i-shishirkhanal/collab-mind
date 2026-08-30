"""
rag/generator.py — Logic for Studio content generation using Gemini with document extraction fallback.
"""

import json
import asyncio
import os
import asyncpg
import google.generativeai as genai

from rag.retriever import retrieve_chunks

from schemas import (
    FlashcardRequest, FlashcardsResponse, FlashcardItem,
    QuizRequest, QuizResponse, QuizQuestion,
    StudyGuideRequest, StudyGuideResponse, StudyGuideSection,
    ReportRequest, ReportResponse,
    SummarizeRequest, SummarizeResponse
)

MODEL = "gemini-1.5-flash"


async def _get_context(pool: asyncpg.Pool, workspace_id: str, topic: str | None, top_k: int = 25) -> tuple[str, list[dict]]:
    query = topic if topic else "General overview and key points"
    chunks = await retrieve_chunks(pool, workspace_id, query, top_k=top_k)
    
    if not chunks:
        return "No relevant context found in workspace sources.", []
    
    context_str = "=== WORKSPACE CONTEXT ===\n"
    for i, c in enumerate(chunks, 1):
        context_str += f"[{i}] Source: {c['source_name']}\n{c['content']}\n\n"
    return context_str, chunks


def _get_gemini_client() -> genai.GenerativeModel:
    return genai.GenerativeModel(
        model_name=MODEL,
        generation_config={"response_mime_type": "application/json"}
    )


async def summarize_source(pool: asyncpg.Pool, request: SummarizeRequest) -> SummarizeResponse:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT sc.content, s.name AS source_name
            FROM source_chunks sc
            JOIN sources s ON s.id = sc.source_id AND s.workspace_id = sc.workspace_id
            WHERE sc.workspace_id = $1 AND sc.source_id = $2
            ORDER BY sc.chunk_index ASC
            """,
            request.workspace_id,
            request.source_id
        )

    source_name = rows[0]["source_name"] if rows else "Uploaded Document"
    full_text = "\n".join(row["content"] for row in rows) if rows else ""
    
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if api_key and not api_key.startswith("dummy") and full_text:
        try:
            prompt = (
                f"You are a study assistant. Produce an executive summary for this document: '{source_name}'.\n\n"
                f"{full_text[:12000]}\n\n"
                f"RETURN JSON FORMAT:\n"
                f'{{"summary": "...", "key_takeaways": ["...", "..."]}}'
            )
            model = _get_gemini_client()
            response = await asyncio.to_thread(model.generate_content, prompt)
            data = json.loads(response.text)
            return SummarizeResponse(
                source_id=request.source_id,
                source_name=source_name,
                summary=data.get("summary", ""),
                key_takeaways=data.get("key_takeaways", []),
                word_count=len(full_text.split())
            )
        except Exception as exc:
            print(f"[Generator] Gemini API error ({exc}). Using document extraction summary.")

    if full_text:
        lines = [l.strip() for l in full_text.split("\n") if len(l.strip()) > 15]
        summary_text = " ".join(lines[:4]) if lines else full_text[:400]
        takeaways = [l[:100] for l in lines[4:8]] if len(lines) > 4 else ["Key Document Concept", "Core Analysis"]
        return SummarizeResponse(
            source_id=request.source_id,
            source_name=source_name,
            summary=summary_text,
            key_takeaways=takeaways,
            word_count=len(full_text.split())
        )
    else:
        return SummarizeResponse(
            source_id=request.source_id,
            source_name=source_name,
            summary="Document content is indexed. Select this source to view full chunk details.",
            key_takeaways=["Indexed Document", "Ready for RAG and Studio tools"],
            word_count=0
        )


async def generate_flashcards(pool: asyncpg.Pool, request: FlashcardRequest) -> FlashcardsResponse:
    context, chunks = await _get_context(pool, request.workspace_id, request.topic, top_k=30)
    
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if api_key and not api_key.startswith("dummy"):
        try:
            prompt = (
                f"You are a study assistant. Ensure output matches the requested JSON format.\n\n"
                f"Generate exactly {request.count} flashcards extracted from the provided context.\n"
                f"Each flashcard MUST include the exact source filename it was derived from.\n\n"
                f"{context}\n\n"
                f"RETURN JSON FORMAT:\n"
                f'{{"flashcards": [{{"front": "...", "back": "...", "source_ref": "..."}}]}}'
            )
            model = _get_gemini_client()
            response = await asyncio.to_thread(model.generate_content, prompt)
            data = json.loads(response.text)
            return FlashcardsResponse(**data)
        except Exception as exc:
            print(f"[Generator] Gemini API error ({exc}). Using document extraction for flashcards.")

    items = []
    if chunks:
        for idx in range(request.count):
            c = chunks[idx % len(chunks)]
            lines = [l.strip() for l in c["content"].split("\n") if l.strip() and len(l.strip()) > 3]
            front_text = lines[0] if lines else f"Key concept from {c['source_name']}"
            back_text = " ".join(lines[1:4]) if len(lines) > 1 else c["content"][:220]
            
            items.append(FlashcardItem(
                front=front_text[:90],
                back=back_text[:250] or "Key insight extracted from workspace source.",
                source_ref=c["source_name"]
            ))
    else:
        for i in range(1, request.count + 1):
            items.append(FlashcardItem(
                front=f"Upload a Document to Generate Flashcard #{i}",
                back="Go to the Sources tab to upload PDFs, Word documents, or links. The system will automatically index them for study generation.",
                source_ref="System Guide"
            ))

    return FlashcardsResponse(flashcards=items)


async def generate_quiz(pool: asyncpg.Pool, request: QuizRequest) -> QuizResponse:
    context, chunks = await _get_context(pool, request.workspace_id, request.topic, top_k=30)
    
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if api_key and not api_key.startswith("dummy"):
        try:
            prompt = (
                f"You are a test-prep instructor. Output MUST be valid JSON.\n\n"
                f"Generate {request.count} multiple-choice quiz questions focusing on '{request.topic}'.\n"
                f"The difficulty level should be {request.difficulty}.\n"
                f"Basing all answers strictly on the provided context.\n\n"
                f"{context}\n\n"
                f"RETURN JSON FORMAT:\n"
                f'{{"questions": [{{"question": "...", "options": ["A", "B", "C", "D"], "correct": "A", "explanation": "...", "source_ref": "..."}}]}}'
            )
            model = _get_gemini_client()
            response = await asyncio.to_thread(model.generate_content, prompt)
            data = json.loads(response.text)
            return QuizResponse(**data)
        except Exception as exc:
            print(f"[Generator] Gemini API error ({exc}). Using document extraction for quiz.")

    questions = []
    if chunks:
        for i in range(request.count):
            c = chunks[i % len(chunks)]
            lines = [l.strip() for l in c["content"].split("\n") if l.strip() and len(l.strip()) > 5]
            q_topic = lines[0] if lines else c["source_name"]
            ans_text = " ".join(lines[1:3]) if len(lines) > 1 else c["content"][:150]
            
            questions.append(QuizQuestion(
                question=f"Question {i + 1}: Based on {c['source_name']}, which statement best describes '{q_topic[:60]}...'?",
                options=[
                    f"A) {ans_text[:90]}",
                    "B) It contradicts the core specifications outlined in the source document.",
                    "C) It is strictly applicable only to legacy unindexed text files.",
                    "D) None of the above"
                ],
                correct=f"A) {ans_text[:90]}",
                explanation=f"Extracted directly from {c['source_name']}: {c['content'][:180]}...",
                source_ref=c["source_name"]
            ))
    else:
        questions.append(QuizQuestion(
            question="No documents uploaded yet. How do you generate custom quizzes?",
            options=[
                "A) Upload PDFs or notes in the Sources tab",
                "B) Delete the workspace",
                "C) Wait for manual entry",
                "D) Turn off the database"
            ],
            correct="A) Upload PDFs or notes in the Sources tab",
            explanation="Uploading documents allows pgvector to index text chunks for quiz creation.",
            source_ref="System Guide"
        ))

    return QuizResponse(questions=questions)


async def generate_study_guide(pool: asyncpg.Pool, request: StudyGuideRequest) -> StudyGuideResponse:
    context, chunks = await _get_context(pool, request.workspace_id, request.topic, top_k=30)
    
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if api_key and not api_key.startswith("dummy"):
        try:
            prompt = (
                f"You are a textbook author. Output MUST be valid JSON.\n\n"
                f"Create a structured, highly comprehensive study guide for '{request.topic}'.\n"
                f"Use only information present in the context below.\n\n"
                f"{context}\n\n"
                f"RETURN JSON FORMAT:\n"
                f'{{"title": "...", "sections": [{{"heading": "...", "content": "...", "key_terms": ["...", "..."]}}]}}'
            )
            model = _get_gemini_client()
            response = await asyncio.to_thread(model.generate_content, prompt)
            data = json.loads(response.text)
            return StudyGuideResponse(**data)
        except Exception as exc:
            print(f"[Generator] Gemini API error ({exc}). Using document extraction for study guide.")

    sections = []
    if chunks:
        grouped = {}
        for c in chunks:
            s_name = c["source_name"]
            grouped.setdefault(s_name, []).append(c["content"])

        for s_name, content_list in list(grouped.items())[:5]:
            full_text = "\n".join(content_list)
            lines = [l.strip() for l in full_text.split("\n") if l.strip()]
            terms = [l[:30] for l in lines[1:5] if len(l) > 3] or ["Key Concept", "Analysis"]
            sections.append(StudyGuideSection(
                heading=f"Section: {s_name}",
                content=full_text[:600],
                key_terms=terms[:4]
            ))
    else:
        sections.append(StudyGuideSection(
            heading="1. Getting Started",
            content="Upload course materials or documents into your workspace to automatically build comprehensive study guides.",
            key_terms=["Upload Documents", "RAG Search", "Automated Summaries"]
        ))

    return StudyGuideResponse(title=f"Study Guide: {request.topic or 'Workspace Materials'}", sections=sections)


async def generate_report(pool: asyncpg.Pool, request: ReportRequest) -> ReportResponse:
    combined_query = request.title + " " + " ".join(request.outline_points)
    context, chunks = await _get_context(pool, request.workspace_id, combined_query, top_k=40)
    
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if api_key and not api_key.startswith("dummy"):
        try:
            prompt = (
                f"You are a professional research analyst.\n"
                f"Write a comprehensive markdown report titled: '{request.title}'.\n"
                f"You must strictly follow this outline: {request.outline_points}.\n"
                f"You must rely ONLY on the provided context. Insert inline citations where appropriate.\n\n"
                f"=== WORKSPACE CONTEXT ===\n{context}"
            )
            model = genai.GenerativeModel(model_name="gemini-1.5-pro")
            response = await asyncio.to_thread(model.generate_content, prompt)
            return ReportResponse(report_markdown=response.text)
        except Exception as exc:
            print(f"[Generator] Gemini API error ({exc}). Using document extraction for report.")

    report_md = f"# {request.title}\n\n"
    if chunks:
        for idx, pt in enumerate(request.outline_points):
            c = chunks[idx % len(chunks)]
            report_md += f"## {pt}\n\n"
            report_md += f"{c['content']}\n\n*Source Citation: [{c['source_name']}]*\n\n"
    else:
        for pt in request.outline_points:
            report_md += f"## {pt}\n\n"
            report_md += "Please upload documents to populate this report section with workspace data.\n\n"

    return ReportResponse(report_markdown=report_md)
