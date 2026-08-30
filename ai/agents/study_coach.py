"""
agents/study_coach.py — The Study Coach agent.

This agent helps students by:
  - Explaining concepts from their workspace documents
  - Generating quiz questions
  - Creating concise summaries

It gets these capabilities through tools (Python functions) that it can
call during the ReAct loop.  Every tool that touches the DB MUST scope
its query to the workspace_id passed through graph state.
"""

import asyncpg
from langchain.tools import tool          # Decorator that turns a function into a LangGraph tool
from agents.base_agent import BaseAgent    # Our abstract parent class


# ── Tool definitions ──────────────────────────────────────────────────────────
# Tools are defined outside the class because @tool decorators work on plain
# functions.  We pass `pool` in via a closure at agent-creation time.

def make_study_coach_tools(pool: asyncpg.Pool) -> list:
    """
    Factory function that closes over `pool` so every tool has DB access
    without exposing pool as a global variable.
    """

    @tool
    async def explain_concept(concept: str, workspace_id: str) -> str:
        """
        Retrieve chunks related to `concept` from the workspace and return them.
        The agent will use this raw text to compose an explanation in its own words.
        """
        # Import here to avoid a circular import (pipeline imports retriever, which
        # is imported at module level in pipeline; importing inside the function
        # is the clean way to handle this in a flat package structure).
        from rag.retriever import retrieve_chunks   # type: ignore

        chunks = await retrieve_chunks(pool, workspace_id, concept, top_k=4)
        if not chunks:
            return "No relevant content found in this workspace for that concept."

        # Join the chunk texts into one block the agent can read.
        passages = "\n---\n".join(c["content"] for c in chunks)
        return passages

    @tool
    async def generate_quiz(topic: str, workspace_id: str) -> str:
        """
        Retrieve content about `topic` and ask Gemini (via the agent's own LLM)
        to produce a 5-question multiple-choice quiz based ONLY on that content.

        The agent will call this tool, read the returned passages, and then
        formulate the quiz itself — this keeps quiz generation within the
        ReAct loop rather than adding a separate API call.
        """
        from rag.retriever import retrieve_chunks   # type: ignore

        chunks = await retrieve_chunks(pool, workspace_id, topic, top_k=6)
        if not chunks:
            return "No content found for this topic. Cannot generate a quiz."

        passages = "\n---\n".join(c["content"] for c in chunks)
        # Return the raw passages; the agent will compose the actual quiz questions.
        return f"Use the following passages to create a 5-question quiz:\n\n{passages}"

    @tool
    async def summarise_source(source_name: str, workspace_id: str) -> str:
        """
        Fetch all chunks for a given source and return them concatenated.
        The agent will then write a concise summary.
        """
        # We query the DB directly here because we want ALL chunks of a specific source,
        # not the top-k closest to a query vector.
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT sc.content
                FROM   source_chunks sc
                JOIN   sources s
                    ON s.id            = sc.source_id
                    AND s.workspace_id = sc.workspace_id
                WHERE  sc.workspace_id = $1       -- hard isolation guard
                AND    s.name          = $2        -- match by human-readable name
                ORDER  BY sc.chunk_index ASC      -- preserve reading order
                """,
                workspace_id,  # $1
                source_name,   # $2
            )

        if not rows:
            return f"Source '{source_name}' not found in this workspace."

        full_text = "\n".join(row["content"] for row in rows)
        return f"Summarise the following document:\n\n{full_text}"

    # Return all three tools in a list so BaseAgent can pass them to create_react_agent.
    return [explain_concept, generate_quiz, summarise_source]


# ── Agent class ───────────────────────────────────────────────────────────────

class StudyCoachAgent(BaseAgent):
    """
    Specialist agent for study assistance.
    Inherits the __init__, graph construction, and arun() from BaseAgent.
    We only need to supply tools and the system prompt.
    """

    def __init__(self, pool: asyncpg.Pool):
        # Store pool so tools can use it, then call the parent __init__
        # which builds the LangGraph graph using self.tools and self.system_prompt.
        self._pool = pool
        super().__init__()   # Must come AFTER self._pool is set, because super().__init__ reads self.tools

    @property
    def tools(self) -> list:
        """Return the study-specific tools, bound to this agent's DB pool."""
        return make_study_coach_tools(self._pool)

    @property
    def system_prompt(self) -> str:
        return (
            "You are Study Coach, an AI tutor integrated into CollabMind AI.\n"
            "Your job is to help students understand material from their uploaded workspace documents.\n\n"
            "Rules you MUST follow:\n"
            "1. ONLY use information from the workspace documents (via your tools).\n"
            "2. NEVER answer from general knowledge — if the answer isn't in the documents, say so.\n"
            "3. When explaining a concept, call the `explain_concept` tool first.\n"
            "4. When asked for a quiz, call the `generate_quiz` tool first.\n"
            "5. When asked to summarise a document, call the `summarise_source` tool first.\n"
            "6. Always cite the source name when giving an answer.\n"
        )
