"""
rag/pipeline.py — Ties retrieval and generation together.
"""

import os
import google.generativeai as genai
import asyncpg

from rag.retriever import retrieve_chunks
from schemas import Citation

GENERATION_MODEL = "gemini-1.5-flash"


def _build_prompt(
    query: str,
    chunks: list[dict],
    conversation_history: list[dict],
) -> str:
    system_instruction = (
        "You are a helpful study assistant for CollabMind AI.\n"
        "IMPORTANT: You MUST answer ONLY using the context passages provided below.\n"
        "If the answer cannot be found in the passages, say exactly:\n"
        "\"I could not find an answer in your workspace sources.\"\n"
        "Do NOT use any outside knowledge. Do NOT make up information.\n\n"
    )

    context_section = "=== CONTEXT PASSAGES ===\n"
    for i, chunk in enumerate(chunks, start=1):
        context_section += (
            f"[{i}] Source: {chunk['source_name']} | Chunk: {chunk['chunk_index']}\n"
            f"{chunk['content']}\n\n"
        )

    history_section = "=== CONVERSATION HISTORY ===\n"
    for turn in conversation_history:
        role_label = "User" if turn.get("role") == "user" else "Assistant"
        history_section += f"{role_label}: {turn.get('content', '')}\n"

    question_section = f"\n=== CURRENT QUESTION ===\nUser: {query}\nAssistant:"
    return system_instruction + context_section + history_section + question_section


def _extract_citations(chunks: list[dict]) -> list[Citation]:
    citations = []
    for chunk in chunks:
        citations.append(Citation(
            source_name=chunk["source_name"],
            page_number=chunk.get("page_number"),
            chunk_index=chunk["chunk_index"],
        ))
    return citations


async def run_rag_pipeline(
    pool: asyncpg.Pool,
    workspace_id: str,
    message: str,
    conversation_history: list[dict],
) -> tuple[str, list[Citation]]:
    chunks = await retrieve_chunks(pool, workspace_id, message)

    if not chunks:
        return (
            "I could not find an answer in your workspace sources.",
            [],
        )

    prompt = _build_prompt(message, chunks, conversation_history)
    citations = _extract_citations(chunks)

    api_key = os.environ.get("GEMINI_API_KEY", "")
    if api_key and not api_key.startswith("dummy"):
        try:
            model = genai.GenerativeModel(GENERATION_MODEL)
            response = model.generate_content(prompt)
            return response.text, citations
        except Exception as exc:
            print(f"[Pipeline] Gemini API error ({exc}). Using context extraction fallback.")

    # Context extraction fallback when API key is missing/invalid
    excerpt = chunks[0]["content"][:300] if chunks else ""
    answer = f"Based on your workspace source ({chunks[0]['source_name']}):\n\n{excerpt}"
    return answer, citations
