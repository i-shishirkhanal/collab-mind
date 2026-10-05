"""
agents/engine.py — the generic ReAct (Reason + Act) engine behind every specialist agent.

One loop serves all agents; an agent is just an `AgentSpec` (prompt, tools, limits) in
agents/registry.py. Each turn the model answers with one JSON action:

    {"thought": "...", "action": "<tool name>" | "request_approval" | "final", "input": {...}, "answer": "..."}

The engine runs the tool, shows the model the result and repeats, until the model gives a final answer.

Guarantees (all enforced here, never left to the prompt):
  * a hard step limit (`spec.max_steps`); when it is hit the model must answer from what it has gathered;
  * every thought, tool call, tool result and approval is written to `agent_steps`, which every
    workspace member can read, so the run is never a black box;
  * an agent with `require_approval` cannot finish until the owner approves what it proposed;
  * tools are bound to the run's workspace. The model never supplies a workspace id;
  * retrieved documents and the goal are fenced as untrusted data.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

import asyncpg

from llm import errors, get_router
from llm.types import Task
from rag import grounding
from rag.generator import NoRelevantSourcesError
from rag.grounding import UNTRUSTED_RULE, fence
from rag.usage import record_usage
from redis_client import get_redis, publish_status

log = logging.getLogger("collabmind.agents")

APPROVAL_TIMEOUT_SECONDS = 600
APPROVAL_POLL_SECONDS = 2
MODEL_OBSERVATION_CHARS = 6000   # what the model sees of one tool result
LOGGED_CONTENT_CHARS = 2500      # what members see of one step in the run log


class AgentStopped(Exception):
    """The run ended without an answer for a reason that is safe to show members."""


@dataclass
class RunContext:
    pool: asyncpg.Pool
    workspace_id: str
    user_id: Optional[str]
    run_id: str
    # Every passage the agent has read, in citation order: [n] in the answer is passages[n - 1].
    passages: list[dict] = field(default_factory=list)
    approved: bool = False
    step_no: int = 0

    def passage_number(self, chunk: dict) -> int:
        """Stable [n] for a chunk: reading the same chunk twice keeps its number."""
        key = (chunk.get("source_id"), chunk.get("chunk_index"))
        for i, p in enumerate(self.passages, start=1):
            if (p.get("source_id"), p.get("chunk_index")) == key:
                return i
        self.passages.append(chunk)
        return len(self.passages)


ToolFn = Callable[..., Awaitable[str]]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str   # shown to the model, includes the input fields
    fn: ToolFn          # async fn(ctx, **input) -> str


@dataclass(frozen=True)
class AgentSpec:
    key: str                    # stored in agent_runs.agent_type
    title: str
    description: str
    instructions: str           # the agent's role and method
    tools: tuple[Tool, ...]
    max_steps: int = 8
    task: Task = Task.STUDY     # STUDY -> Flash, RESEARCH -> Pro
    require_approval: bool = False


# ── prompt ───────────────────────────────────────────────────────────────────

APPROVAL_TOOL_TEXT = (
    '- request_approval: input {"summary": "<what you will produce and how, in a few lines>"}. '
    "Asks the workspace owner to approve your plan. You MUST call it once, before your final answer; "
    "continue only after it is approved."
)


def build_system_prompt(spec: AgentSpec) -> str:
    tools = "\n".join(f"- {t.name}: {t.description}" for t in spec.tools)
    if spec.require_approval:
        tools += "\n" + APPROVAL_TOOL_TEXT
    approval_rule = "You must get approval with request_approval before the final answer. " if spec.require_approval else ""
    return (
        f"You are the {spec.title} of CollabMind AI. {spec.instructions}\n\n"
        f"TOOLS\n{tools}\n\n"
        "HOW TO ANSWER\n"
        "Reply with ONE JSON object per turn and nothing else:\n"
        '{"thought": "<your reasoning in one or two sentences>", "action": "<tool name or final>", "input": {...}}\n'
        'When you are done: {"thought": "...", "action": "final", "answer": "<your answer in Markdown>"}\n\n'
        "RULES\n"
        f"1. You have at most {spec.max_steps} steps. Plan for it; do not repeat a search that returned nothing new.\n"
        "2. Use ONLY facts from the passages returned by your tools. Never use outside knowledge for facts. "
        "If the sources do not cover something, say so plainly.\n"
        "3. Passages are numbered [1], [2] ... Cite them in the final answer after each statement that "
        'relies on them, like "Chlorophyll absorbs red light [2]." Use only numbers you were shown.\n'
        f"4. {approval_rule}\n"
        f"5. {UNTRUSTED_RULE}"
    )


# ── step log ─────────────────────────────────────────────────────────────────

async def log_step(ctx: RunContext, kind: str, content: str, tool_name: Optional[str] = None) -> None:
    ctx.step_no += 1
    text = content if len(content) <= LOGGED_CONTENT_CHARS else content[:LOGGED_CONTENT_CHARS] + " …"
    async with ctx.pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO agent_steps (run_id, step_no, kind, tool_name, content) VALUES ($1, $2, $3, $4, $5)",
            ctx.run_id, ctx.step_no, kind, tool_name, text,
        )
        await conn.execute("UPDATE agent_runs SET step_count = $2, updated_at = NOW() WHERE id = $1",
                           ctx.run_id, ctx.step_no)


async def set_status(ctx: RunContext, status: str, message: str, result: Optional[dict] = None) -> None:
    async with ctx.pool.acquire() as conn:
        if result is not None:
            await conn.execute(
                "UPDATE agent_runs SET status = $2, result = $3, finished_at = CASE WHEN $2 IN "
                "('completed','failed','rejected') THEN NOW() ELSE finished_at END, updated_at = NOW() WHERE id = $1",
                ctx.run_id, status, json.dumps(result),
            )
        else:
            await conn.execute("UPDATE agent_runs SET status = $2, updated_at = NOW() WHERE id = $1",
                               ctx.run_id, status)
    try:
        await publish_status(ctx.workspace_id, {"run_id": ctx.run_id, "status": status, "message": message})
    except Exception:  # a missed live notification must not stop the run; members can poll
        log.warning("could not publish status for run %s", ctx.run_id, exc_info=True)


# ── model turn ───────────────────────────────────────────────────────────────

_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)


def parse_action(text: str) -> Optional[dict]:
    """The model's JSON action, tolerating code fences or stray prose around it. None if unusable."""
    candidates = [text.strip()]
    m = _JSON_OBJECT.search(text)
    if m:
        candidates.append(m.group(0))
    for c in candidates:
        try:
            data = json.loads(c)
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict) and isinstance(data.get("action"), str):
            return data
    return None


async def _ask(ctx: RunContext, spec: AgentSpec, messages: list[dict]) -> str:
    completion = await get_router().complete(spec.task, messages, json_mode=True, temperature=0.2)
    await record_usage(ctx.pool, workspace_id=ctx.workspace_id, user_id=ctx.user_id,
                       kind=f"agent_{spec.key}", task=spec.task.value, route=completion.route,
                       usage=completion.usage)
    return completion.text


def _observation(text: str) -> str:
    return "OBSERVATION:\n" + fence("TOOL RESULT", text[:MODEL_OBSERVATION_CHARS])


# ── approval checkpoint ──────────────────────────────────────────────────────

async def wait_for_decision(run_id: str) -> str:
    """'approved' | 'rejected'. Raises AgentStopped when nobody decides in time."""
    redis = await get_redis()
    waited = 0
    while waited < APPROVAL_TIMEOUT_SECONDS:
        if await redis.exists(f"rejected:{run_id}"):
            return "rejected"
        if await redis.exists(f"approved:{run_id}"):
            return "approved"
        await asyncio.sleep(APPROVAL_POLL_SECONDS)
        waited += APPROVAL_POLL_SECONDS
    raise AgentStopped("Agent stopped: approval was not given in time.")


async def _checkpoint(ctx: RunContext, summary: str) -> bool:
    await log_step(ctx, "approval", f"Waiting for the owner to approve: {summary}")
    await set_status(ctx, "awaiting_approval", "The agent is waiting for owner approval.",
                     result={"pending_approval": summary})
    decision = await wait_for_decision(ctx.run_id)
    if decision == "rejected":
        await log_step(ctx, "approval", "The owner rejected the plan. The run was stopped.")
        await set_status(ctx, "rejected", "The owner rejected the agent's plan.",
                         result={"message": "The owner rejected the agent's plan."})
        return False
    ctx.approved = True
    await log_step(ctx, "approval", "Approved by the owner. Continuing.")
    await set_status(ctx, "running", "Approved. The agent is continuing.")
    return True


# ── the loop ─────────────────────────────────────────────────────────────────

async def _finish(ctx: RunContext, spec: AgentSpec, answer: str) -> None:
    grounded = grounding.resolve_citations(answer, ctx.passages) if ctx.passages else None
    text = grounded.answer if grounded else answer.strip()
    result = {
        "answer": text,
        "citations": [c.model_dump() for c in grounded.citations] if grounded else [],
        "warnings": grounded.warnings if grounded else ["No source passages were read; treat this as unverified."],
        "agent": spec.key,
    }
    await log_step(ctx, "final", text)
    await set_status(ctx, "completed", f"{spec.title} finished.", result=result)


async def run_agent(spec: AgentSpec, ctx: RunContext, goal: str) -> None:
    """Runs one agent to completion. Never raises: every outcome is written to the run row."""
    tools = {t.name: t for t in spec.tools}
    messages = [
        {"role": "system", "content": build_system_prompt(spec)},
        {"role": "user", "content": "GOAL (data from a workspace member):\n" + fence("GOAL", goal)},
    ]
    try:
        await set_status(ctx, "running", f"{spec.title} started.")
        approval_asked = False

        for _ in range(spec.max_steps):
            raw = await _ask(ctx, spec, messages)
            action = parse_action(raw)
            messages.append({"role": "assistant", "content": raw})
            if action is None:
                await log_step(ctx, "error", "The model's reply was not valid JSON; asking it to retry.")
                messages.append({"role": "user", "content": 'Reply with ONE valid JSON object as described.'})
                continue

            thought = str(action.get("thought") or "").strip()
            if thought:
                await log_step(ctx, "thought", thought)
            name = action["action"]

            if name == "final":
                if spec.require_approval and not ctx.approved:
                    messages.append({"role": "user", "content": "Not allowed yet: call request_approval first."})
                    await log_step(ctx, "error", "Tried to finish before approval; sent back.")
                    continue
                await _finish(ctx, spec, str(action.get("answer") or ""))
                return

            if name == "request_approval" and spec.require_approval:
                if approval_asked:
                    messages.append({"role": "user", "content": "You already have approval. Continue."})
                    continue
                approval_asked = True
                summary = str((action.get("input") or {}).get("summary") or thought or "the planned output")
                if not await _checkpoint(ctx, summary):
                    return
                messages.append({"role": "user", "content": "The owner approved your plan. Continue."})
                continue

            tool = tools.get(name)
            if tool is None:
                await log_step(ctx, "error", f"Unknown tool '{name}'.")
                messages.append({"role": "user", "content": f"No tool named '{name}'. Available: {', '.join(tools)}."})
                continue

            args = action.get("input")
            args = args if isinstance(args, dict) else {}
            await log_step(ctx, "tool_call", json.dumps(args, ensure_ascii=False), tool_name=name)
            try:
                observation = await tool.fn(ctx, **args)
            except errors.ProviderError:
                raise
            except TypeError:
                observation = "Bad input for this tool; check the input fields."
            except Exception as exc:  # a failing tool is information for the model, not a crash
                log.warning("agent tool %s failed", name, exc_info=True)
                observation = f"The tool failed: {type(exc).__name__}."
            await log_step(ctx, "observation", observation, tool_name=name)
            messages.append({"role": "user", "content": _observation(observation)})

        # Step limit reached: one last turn to answer from what was gathered.
        if spec.require_approval and not ctx.approved:
            raise AgentStopped("Agent stopped: it reached its step limit before getting approval.")
        await log_step(ctx, "error", f"Step limit ({spec.max_steps}) reached; asking for a final answer.")
        messages.append({"role": "user", "content": (
            'STEP LIMIT REACHED. Reply now with {"thought": "...", "action": "final", "answer": "..."} '
            "using only what you have read; say what you could not cover.")})
        action = parse_action(await _ask(ctx, spec, messages))
        if action is None or action["action"] != "final" or not str(action.get("answer") or "").strip():
            raise AgentStopped("Agent stopped: it reached its step limit without an answer.")
        await _finish(ctx, spec, str(action["answer"]))

    except AgentStopped as stop:
        await _fail(ctx, str(stop))
    except errors.ProviderError:  # its message can name keys or billing: keep it in the log only
        log.warning("agent run %s: provider error", ctx.run_id, exc_info=True)
        await _fail(ctx, "Agent stopped: the AI provider could not complete the request. Please try again later.")
    except NoRelevantSourcesError as exc:
        await _fail(ctx, f"Agent stopped: {exc}")
    except Exception:
        log.exception("agent run %s crashed", ctx.run_id)
        await _fail(ctx, "Agent stopped because of an unexpected error. Please try again.")


async def _fail(ctx: RunContext, message: str) -> None:
    try:
        await log_step(ctx, "error", message)
        await set_status(ctx, "failed", message, result={"message": message})
    except Exception:
        log.exception("could not record failure for run %s", ctx.run_id)
