# Agentic AI Layer — Build Plan

## Where we are
- Only **Study Coach** exists: fixed LangGraph pipeline (`ai/agents/study_coach_graph.py`), approval gate via Redis key, status polling, `agent_runs` table, UI in `AgentTool.tsx`, routes in `backend/src/routes/agents.js`.
- `ai/agents/base_agent.py` has an unused ReAct base (`create_react_agent`) — no step limit, no logging.
- **LLM is DeepSeek (OpenAI-compatible), not Gemini.** Decide: keep DeepSeek and fix the wording, or add a Gemini provider. This plan assumes DeepSeek; swapping later only touches `BaseAgent.graph`.

## Target design
One generic runner + registry instead of one bespoke graph per agent.

```
POST /agents/{type}  ->  agent_runs row  ->  runner (ReAct loop, max N steps)
                                                |-- each tool call/observation -> agent_steps row + realtime publish
                                                |-- approval checkpoint before costly/side-effect tools
                                                '-- result saved to agent_runs.result
```

## Phase 0 — Decisions (0.5 day)
1. Model: DeepSeek vs Gemini (see above).
2. Which agents ship: recommended Research, Report Builder, Debate, Literature Review first; Knowledge Organizer and Project Manager last/optional.
3. Wording: claim only what's live.

## Phase 1 — Foundation (1–2 days)
- **Migration**: `agent_steps(id, run_id, step_no, kind[thought|tool_call|observation|approval|final], tool_name, input jsonb, output jsonb, created_at)` + RLS so only workspace members read it. Add `agent_runs.step_count`, and widen the `agent_type` / status checks.
- **Registry** `ai/agents/registry.py`: `AgentSpec(name, system_prompt, tools, max_steps, approval_tools)`.
- **Generic runner** `ai/agents/react_runner.py`: LangGraph ReAct with `recursion_limit = max_steps`; on each step write `agent_steps` and publish status; before any tool in `approval_tools` pause on the existing Redis approval key (reuse `/approve`; keep 300s timeout and the backend 409 guard).
- **Shared tools** `ai/agents/tools/`: `search_sources` (existing RAG retrieval, always workspace-scoped), `web_search` (reuse chat's web source), `get_source`, `save_artifact`.
- **API**: single `POST /agents/{type}`, `GET /agents/{run_id}/steps`; backend proxy `POST /:workspaceId/agents/:type` (costly guard + member check) and `GET .../steps`.
- **UI**: generic `AgentRunPanel` (goal input, live step log visible to all members, approve button for owner/admin only). Refactor `AgentTool.tsx` onto it. Add an "Agents" tab in Studio with an agent picker.
- **Migrate Study Coach** onto the runner (keep its plan→approve→generate flow as `approval_tools`), or leave the graph and just add step logging. Cheaper: leave it, add logging.

Exit criteria: a dummy agent runs end-to-end, stops at max steps, every step visible to a second member, approval blocks until the owner approves.

## Phase 2 — Agents (each ~0.5–1 day once foundation exists)
| Agent | Tools | Approval gate | Output |
|---|---|---|---|
| Research | search_sources, web_search | before web_search batch | cited synthesis |
| Report Builder | search_sources, outline, draft_section | after outline | report saved to Studio (reuse report storage) |
| Debate | search_sources | none | pro/con + comparison table |
| Literature Review | search_sources | after gap analysis plan | review with gaps |
| Knowledge Organizer | list_chunks, embed/cluster, find_duplicates | before any merge/delete (suggest only) | concept clusters, duplicate list |
| Project Manager | workspace activity, members, sources, runs | none (read-only) | progress + gaps |

Per agent: prompt, tools, `AgentSpec`, one UI result renderer, one test.

## Phase 3 — Safety and cost (0.5 day, alongside Phase 1)
- Per-run caps: steps, tokens, wall-clock; per-workspace concurrent runs = 1.
- Rate limit through existing `costlyGuard`.
- Tools never take `workspace_id` from the model — injected by the runner.
- Treat retrieved text as data (prompt-injection): wrap in delimiters, tools can't trigger approval-less side effects.
- Redact via existing `llm/redaction.py`.

## Phase 4 — Tests and docs (1 day)
- Unit: step-limit stop, approval timeout, tool scoping per workspace, RLS on `agent_steps`.
- Integration (extend `backend/test/phase4.integration.test.js`): start run, member sees steps, non-owner cannot approve.
- Update README and `docs/` with real agent list.

## Order and estimate
Phase 0 → 1 (+3) → Research → Report Builder → Debate → Literature Review → Phase 4 → (Organizer, PM if time).
~5–7 days for foundation + four agents; +2–3 days for the last two.

## Risks
- DeepSeek tool-calling is weaker than Gemini's; Research/Debate may need tighter prompts.
- Long runs on FastAPI BackgroundTasks die on restart — `reaper.py` already marks stale runs; keep it.
- Organizer needs embedding/clustering work (sklearn or pgvector queries) — the largest unknown.

---

## Status (2026-10-05)

**Built:** foundation (`agent_steps` migration, `ai/agents/engine.py`, `registry.py`, `tools.py`, `POST /agents/run`, reject route, steps route, owner/admin-only approve/reject, `AgentRunPanel` in Studio) and four agents: **Research, Literature Review, Debate, Report Builder**. Study Coach is unchanged (fixed graph).

**How it differs from the plan:**
- The loop asks the model for one JSON action per turn through the existing model router (DeepSeek). It does not use native function calling, so retries, fallback and usage tracking are shared with the rest of the service.
- Research reads workspace sources only. There is no live web-search tool (the app has no search API key); the plan's `web_search` was dropped.
- Approval checkpoints: Literature Review (before writing) and Report Builder (outline). Research and Debate run without one.
- Step limits: Research 8, Debate 8, Literature Review 10, Report Builder 10, plus a forced final answer when the limit is hit.

**Not built (deliberately):** Knowledge Organizer and Project Manager agents.

**Not verified:** a live run against a real database, DeepSeek key and browser. Unit tests cover the engine (`ai/tests/test_agent_engine.py`); apply `supabase/migrations/20261005000000_agent_steps.sql` first.

## Future work

Deliberately left out of this phase; each is a self-contained addition on top of the shared engine.
- **Knowledge Organizer agent:** concept clustering and duplicate detection. Needs an embedding/clustering step over `source_chunks`; suggest-only (no merges or deletes without approval).
- **Project Manager agent:** progress tracking and gap detection from workspace activity, members and sources. Read-only.
- **Live web search for the Research agent:** needs a search API and key; the tool slots into `agents/tools.py`.
- **Study Coach on the shared engine:** step log and step limit for the existing fixed pipeline.
