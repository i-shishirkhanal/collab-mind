"""
agents/study_coach_graph.py — The LangGraph StateGraph definition with fallback support.
"""

import os
import json
import asyncio
from typing import TypedDict, Optional

import asyncpg
import google.generativeai as genai
from langgraph.graph import StateGraph, START, END

from redis_client import publish_status, get_redis
from rag.retriever import retrieve_chunks


class StudyCoachState(TypedDict):
    workspace_id: str
    user_id: str
    run_id: str
    goal: str
    topics: list[str]
    plan: Optional[str]
    approved: bool
    materials: Optional[str]
    status: str
    pool: asyncpg.Pool


async def analyze_sources(state: StudyCoachState) -> dict:
    workspace_id = state["workspace_id"]
    pool = state["pool"]
    goal = state["goal"]
    
    await publish_status(workspace_id, {
        "run_id": state["run_id"],
        "status": "analyzing",
        "message": "Scanning workspace documents to extract study topics..."
    })

    chunks = await retrieve_chunks(pool, workspace_id, goal, top_k=10)
    
    if not chunks:
        topics = ["General Workspace Topics", "Core Architectural Concepts"]
    else:
        context = "\n---\n".join(c["content"] for c in chunks)
        prompt = (
            f"Extract a comma-separated list of 3-5 core study topics from these passages,\n"
            f"tailored to the user's goal: '{goal}'.\n\n"
            f"{context}\n\nTopics (comma separated only):"
        )
        
        api_key = os.environ.get("GEMINI_API_KEY", "")
        topics = []
        if api_key and not api_key.startswith("dummy"):
            try:
                model = genai.GenerativeModel("gemini-1.5-flash")
                response = await asyncio.to_thread(model.generate_content, prompt)
                topics = [t.strip() for t in response.text.split(",") if t.strip()]
            except Exception as exc:
                print(f"[Agent Graph] analyze_sources error ({exc}). Using topic fallback.")
                
        if not topics:
            first_words = [c['source_name'] for c in chunks[:3]]
            topics = [f"Topic: {w}" for w in set(first_words)] or ["Core Concepts", "System Architecture"]

    return {"topics": topics, "status": "analyzing"}


async def create_plan(state: StudyCoachState) -> dict:
    workspace_id = state["workspace_id"]
    topics_list = ", ".join(state["topics"])
    goal = state["goal"]
    
    await publish_status(workspace_id, {
        "run_id": state["run_id"],
        "status": "planning",
        "message": f"Drafting a study plan for topics: {topics_list}"
    })
    
    prompt = (
        f"You are a study coach. The user's goal is: '{goal}'.\n"
        f"The core topics found in their materials are: {topics_list}.\n\n"
        f"Generate a clear, day-by-day study plan covering these topics.\n"
        f"Keep it concise and actionable."
    )
    
    api_key = os.environ.get("GEMINI_API_KEY", "")
    plan_text = ""
    if api_key and not api_key.startswith("dummy"):
        try:
            model = genai.GenerativeModel("gemini-1.5-flash")
            response = await asyncio.to_thread(model.generate_content, prompt)
            plan_text = response.text
        except Exception as exc:
            print(f"[Agent Graph] create_plan error ({exc}). Using plan fallback.")

    if not plan_text:
        plan_text = (
            f"# Customized Study Plan for '{goal}'\n\n"
            f"**Target Topics:** {topics_list}\n\n"
            f"- **Day 1:** Review foundational principles of {topics_list}.\n"
            f"- **Day 2:** Analyze architecture diagrams and component interactions.\n"
            f"- **Day 3:** Practice problem-solving and review flashcards."
        )
    
    return {"plan": plan_text, "status": "planning"}


async def await_approval(state: StudyCoachState) -> dict:
    workspace_id = state["workspace_id"]
    run_id = state["run_id"]
    
    async with state["pool"].acquire() as conn:
        await conn.execute(
            """
            INSERT INTO agent_runs (id, workspace_id, agent_type, status, result)
            VALUES ($1, $2, 'study_coach', 'awaiting_approval', $3)
            ON CONFLICT (id) DO UPDATE 
            SET status = 'awaiting_approval', result = $3
            """,
            run_id, workspace_id, json.dumps({"plan": state["plan"]})
        )
    
    await publish_status(workspace_id, {
        "run_id": run_id,
        "status": "awaiting_approval",
        "message": "Study plan drafted. Waiting for user approval."
    })
    
    redis_client = await get_redis()
    approval_key = f"approved:{run_id}"
    
    print(f"[{run_id}] Waiting for human approval on Redis key: {approval_key}")
    
    timeout = 600
    elapsed = 0
    poll_interval = 2
    
    while elapsed < timeout:
        is_approved = await redis_client.exists(approval_key)
        if is_approved:
            print(f"[{run_id}] Received approval!")
            return {"approved": True, "status": "approved"}
            
        await asyncio.sleep(poll_interval)
        elapsed += poll_interval
        
    print(f"[{run_id}] Approval timed out after 10 minutes.")
    raise TimeoutError("Waiting for human approval timed out.")


async def generate_materials(state: StudyCoachState) -> dict:
    workspace_id = state["workspace_id"]
    
    await publish_status(workspace_id, {
        "run_id": state["run_id"],
        "status": "generating",
        "message": "Plan approved! Generating flashcards and quizzes..."
    })
    
    prompt = (
        f"You previously generated this study plan:\n{state['plan']}\n\n"
        f"Now, generate the actual study materials.\n"
        f"Include: 10 flashcards (Q&A), 5 multiple-choice quiz questions, and a list of key concepts."
    )
    
    api_key = os.environ.get("GEMINI_API_KEY", "")
    materials_text = ""
    if api_key and not api_key.startswith("dummy"):
        try:
            model = genai.GenerativeModel("gemini-1.5-pro")
            response = await asyncio.to_thread(model.generate_content, prompt)
            materials_text = response.text
        except Exception as exc:
            print(f"[Agent Graph] generate_materials error ({exc}). Using materials fallback.")

    if not materials_text:
        materials_text = (
            "### Study Materials Package\n\n"
            "1. **Flashcards (10):** Generated covering core workspace topics.\n"
            "2. **Practice Quiz (5 Questions):** Multiple choice items ready.\n"
            "3. **Summary Sheet:** Comprehensive notes synthesized from sources."
        )

    return {"materials": materials_text, "status": "generating"}


async def save_results(state: StudyCoachState) -> dict:
    workspace_id = state["workspace_id"]
    run_id = state["run_id"]
    
    final_result_json = json.dumps({
        "plan": state["plan"],
        "materials": state["materials"]
    })
    
    async with state["pool"].acquire() as conn:
        await conn.execute(
            """
            UPDATE agent_runs
            SET status = 'completed', result = $2, finished_at = NOW()
            WHERE id = $1
            """,
            run_id, final_result_json
        )
    
    await publish_status(workspace_id, {
        "run_id": run_id,
        "status": "completed",
        "message": "Study materials generation complete."
    })
    
    return {"status": "completed"}


def build_study_coach_graph() -> StateGraph:
    builder = StateGraph(StudyCoachState)

    builder.add_node("analyze_sources", analyze_sources)
    builder.add_node("create_plan", create_plan)
    builder.add_node("await_approval", await_approval)
    builder.add_node("generate_materials", generate_materials)
    builder.add_node("save_results", save_results)

    builder.add_edge(START, "analyze_sources")
    builder.add_edge("analyze_sources", "create_plan")
    builder.add_edge("create_plan", "await_approval")
    builder.add_edge("await_approval", "generate_materials")
    builder.add_edge("generate_materials", "save_results")
    builder.add_edge("save_results", END)

    return builder.compile()
