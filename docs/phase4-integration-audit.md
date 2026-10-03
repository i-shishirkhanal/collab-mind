# Phase 4 — Integration audit

Date: 2026-10-03. Scope: Phases 1 (auth/security), 2 (document ingestion), 3 (LLM routing, BGE-M3, RAG) integrated and re-verified.
Method: previous phase reports were treated as claims. Everything below was read in the code, run, or is explicitly marked unverified.
Companion documents: [test report](phase4-test-report.md) · [deployment checklist](phase4-deployment-checklist.md).

**Overall status: Partially integrated — blockers remain.** The system works end to end with a real database, real BGE-M3 embeddings,
the real AI service/backend and a production-mode Compose stack, and every defect found that could be fixed safely was fixed. A **live** provider
check was also run late in Phase 4 (a third-party OpenAI-compatible gateway serving a DeepSeek-V4-Flash model — see P4-022/P4-032): the project's own
client works against it for plain, thinking-flag, JSON-mode and streaming requests, and a grounded RAG prompt produced a correctly cited answer. It is **not**
"ready for staging" until (a) the configured models/endpoint are the ones the product requires (today Pro == Flash and the endpoint is not DeepSeek's own API),
(b) the migrations are applied to the target database (the only Supabase project found has just the initial migration), and (c) the open items in §6 are accepted or closed.

Legend: **[RUN]** executed and observed · **[READ]** established by reading code/config · **[UNVERIFIED]** not executed.

---

## 1. Repository and Git state (inventory)

| Fact | Evidence |
|---|---|
| One shared working tree, one worktree (`git worktree list`). Branches: `main`, `integration/e2e-verification`, `phase2-document-ingestion`, `phase3/ai-models-rag` (all at `4e58f32`), `phase1/auth-security` (checked out, `b6163ee`). | [RUN] |
| `phase1/auth-security` holds **all** of Phases 1-3 as 4 commits made by another session (`818864b`, `d975539`, `34f4876`, `b579be7`, `b6163ee`), including Phase 3 code and tests under a "phase 1" branch name. `origin/main` and `origin/phase1/auth-security` both point at `b6163ee`. Branch names therefore do **not** identify phases; the branches `phase2-…` / `phase3/…` are empty pointers. | [RUN] |
| Uncommitted at the start of Phase 4: Phase 3's late edits (tests, docs, `chatService`, compose, migration tweak). Everything Phase 4 changed is also uncommitted (§5). Nothing was committed or pushed by Phase 4. | [RUN] |
| No stash, no conflicting duplicate implementations found. Three cross-phase **interface mismatches** were found and fixed (P4-002, P4-006, P4-010). | [RUN] |
| `supabase/.temp/**`, `supabase/.branches/`, `.claude/launch.json` are tracked. Contents inspected for credentials with pattern search: none found (bundled edge-runtime JS, a catalog JSON, a branch name). | [RUN] |
| Local `.env` files (root, `ai/`, `backend/`) were not opened; only variable *names* were listed. They predate Phase 1 and lack `AI_SERVICE_TOKEN`, `REDIS_PASSWORD`, `CORS_ORIGINS`: **the services will refuse to start with them** (by design) until updated. | [RUN] |

Safe-integration approach used: no branch switching, no worktree, no destructive Git/DB commands, edits made on the working-tree content only,
a disposable Postgres/Redis/TEI for all execution, one read-only inspection of the live Supabase project (advisors, migration list, row counts — no writes).

## 2. What is verified correct

| Area | Result | Evidence |
|---|---|---|
| Email registration → verification → login; unverified login refused; wrong password/no/garbage token 401; logout revokes the session; sockets refused after logout; no Google/demo path remains in backend or UI | Correct | [RUN] E1, E15, real UI sign-up/verify/sign-in against the Compose stack |
| Workspace membership/roles (non-member 403, member cannot update/delete/add members); every source/chat/studio/agent route is member-gated; ids from another workspace are 404; malformed UUIDs 400 | Correct | [RUN] E2, E7; 97 backend tests incl. real-DB/Redis integration |
| Socket auth: no valid session → refused; join requires DB membership; non-members receive nothing and cannot publish | Correct | [RUN] E6, integration tests |
| Service-to-service auth: AI service rejects missing/wrong token; `/health` open; docs disabled | Correct | [RUN] E7, `tests/test_service_auth.py` |
| PDF ingestion: extraction, page numbers, 1-chunk-per-page, **real BGE-M3 1024-d unit vectors** stored in pgvector with model/dim metadata; `ready` only after chunks commit | Correct | [RUN] E3 |
| Retrieval is workspace-scoped and `ready`-only **in SQL**, thresholded, hybrid; nothing relevant ⇒ no model call | Correct | [RUN] E7 + 9 real-pgvector SQL tests + real-model test |
| Model routing: chat/study → Flash model (thinking off), research (auto or explicit) → Pro model (thinking on), fallback off by default; provider-reported model + token usage persisted | Correct against a **mock** provider (ids `deepseek-flash` / `deepseek-v4-pro`) | [RUN] E4, E5 (requests observed at the mock) |
| Live provider (`inference.dahl.global`, model `deepseek-ai/DeepSeek-V4-Flash-0731`) through `ai/llm/deepseek.py` | Accepts plain, `thinking` enabled/disabled, `response_format: json_object`, `stream` + `include_usage`; usage and response model id parsed; grounded RAG prompt → correct answer, `[1]` resolved to research.pdf p.1; studio JSON parsed and `source_ref` grounded | [RUN] 9 small calls, see P4-032 for the quality problems seen |
| Citations resolve to the retrieved chunk (source id/name, page, label, excerpt from the chunk, never from model text); bad `[n]` stripped; uncited/refusal/no_sources states | Correct | [RUN] E4, 20 grounding/pipeline tests |
| Embedding/LLM outage: chat 503/429/502 with safe messages, no partial writes, upload ends `failed` with 0 chunks and no fake vectors, recovery via retry | Correct | [RUN] E13, E14 |
| Delete source removes row, chunks, stored file and per-upload folder; other sources untouched | Correct | [RUN] E10 |
| Restart of backend + AI keeps sessions, sources, history; retrieval works after restart | Correct | [RUN] E11 |
| Duplicate / concurrent duplicate uploads, empty/binary-as-text/`.exe` rejected, scanned PDF fails honestly with an OCR message and 0 chunks | Correct (after P4-008) | [RUN] E9 |
| Production-mode Compose stack: redis → ai → backend → frontend start in dependency order healthy; services run as uid 1000; shared upload volume writable by both | Correct (after P4-003, P4-016, P4-017) | [RUN] |

## 3. Audit register

Severity: Critical = data exposure / auth bypass / destructive loss; High = core workflow broken or unsafe by default; Medium = significant inconsistency / missing recovery / incomplete validation; Low = hygiene/docs.
Status: **Fixed** (with regression test) · **Open** (not fixed; reason given) · **Unverified**.

### Critical
None confirmed. One *potential* Critical was investigated and downgraded — see P4-004.

### High
| ID | Finding | Evidence / reproduction | Expected vs actual | Resolution | Regression test |
|---|---|---|---|---|---|
| **P4-001** | `agent_runs.finished_at` does not exist in any migration, but `agents/study_coach_graph.py:save_results` and `agents/runner.py` write it. A study-coach run could never be marked `completed` or `failed`. | [RUN] psql `\d agent_runs` on a DB built from the migrations has no such column; E8 now drives a run to `completed`. | Run completes with `finished_at` / actual: SQL error at the last step. | **Fixed**: migration `20261003000000` + idempotent `ensure_schema`. | `ai/tests/test_agent_db.py`, `backend/test/phase4.integration.test.js`, E2E E8 |
| **P4-002** | Citation markers opened the **wrong source**. UI mapped `[n]` → `citations[n-1]`, but Phase 3 returns only the *cited* passages in order of first use, each with its own `index`. "…[2]… [1]" or an answer citing only `[3]` linked to the wrong/no source. | [READ] `ChatMessage.tsx` vs `rag/grounding.py`; unit test reproduces. | `[n]` ⇒ passage n / actual: positional lookup. | **Fixed**: lookup by `citation.index`, positional fallback only for legacy messages (`lib/citations.ts`). | `frontend/tests/citations.test.ts` |
| **P4-003** | In Compose the frontend *server* (NextAuth login) called `http://localhost:4000` = itself. `API_INTERNAL_URL` was never set, so nobody could sign in under Compose. | [READ] `auth.ts` + old compose; fixed config verified by a real UI login through the Compose network. | Login works / actual: connection refused. | **Fixed**: `API_INTERNAL_URL=http://backend:4000` in compose. | Compose bring-up (manual, [RUN]) |
| **P4-004** | Row Level Security is **not enabled** on `users, workspaces, workspace_members, sources, source_chunks, chat_messages, agent_runs` by any repo migration. On hosted Supabase the public anon key would grant API read/write on them. The *live* "colab mind" project already has RLS enabled on all seven (Supabase advisor, [RUN]) — so repo and live DB had drifted; a database built from the repo alone was exposed. | [READ] `grep ROW LEVEL SECURITY supabase/migrations`; [RUN] advisor on project `kvcyhcedtwktmxmjbrcb`. | RLS on / actual: absent in migrations. | **Fixed** in the migration (enable RLS, no policies — all access is via the table-owner backend/AI connections). Not applied to the live project. | `phase4.integration.test.js` (owner connection still works); advisor re-check after applying |
| **P4-005** | Frontend container used `next dev` as root; with `next start`, Auth.js answered **`UntrustedHost`** for every session request, so a production-mode frontend could not sign anyone in. | [RUN] container log + UI failure, fixed and re-tested by UI login. | | **Fixed**: production Dockerfile + `AUTH_TRUST_HOST=true`, `AUTH_URL`, `AUTH_SECRET` in compose. | Compose bring-up [RUN] |
| **P4-006** | Two Phase 1 integration tests failed against the integrated system (768-d vector vs the 1024-d schema; fake AI server knew only `/chat` while the socket path now uses `/chat/stream`). | [RUN] `npm test` with real DB/Redis: 79/81. | | **Fixed** (tests updated; fake AI now serves SSE, so the real streaming path is covered). | `backend/test/auth.integration.test.js` (81/81 → 97 total) |
| **P4-007** | Chat UI showed the AI answer **only** if the socket push arrived; the REST response was ignored. If the socket had not joined the room (or reconnecting) the answer never appeared until reload. | [RUN] reproduced in the production stack: backend persisted a grounded answer, the page showed none. | | **Fixed**: REST result merged by id with the socket event (`lib/chatMessages.ts`, idempotent store). | `frontend/tests/chatMessages.test.ts` |

### Medium
| ID | Finding | Resolution | Regression test |
|---|---|---|---|
| P4-008 | Duplicate-upload race: two simultaneous identical uploads both passed the hash check. | **Fixed**: unique index `uq_sources_workspace_sha256` + 409 handling. | E9, `phase4.integration.test.js` |
| P4-009 | Backend SSRF pre-check accepted `http://[::ffff:7f00:1]/`, `[::7f00:1]`, `[64:ff9b::7f00:1]`, 6to4 (verified by running it). The AI service's own guard blocked them (second layer), but Python 3.11 (the image) classifies IPv6 differently from 3.12+. | **Fixed** both layers (embedded-IPv4 aware). Residual: DNS-rebinding window in the AI fetch (resolve-then-connect). | `backend/test/urlSafety.test.js`, `ai/tests/test_ssrf_guard.py` |
| P4-010 | Socket `chat:message` broadcast the AI reply twice (handler emit + Redis publish). | **Fixed** (`broadcast:false`); E6 asserts exactly one final pair. Partial `chat:delta` previews are now followed by `chat:aborted` on failure. | `chatService.ai.test.js`, E6 |
| P4-011 | Client-supplied `conversation_history` was trusted (forged assistant/system turns steer the model). | **Fixed**: history is always read from the stored workspace conversation. | `chatService.ai.test.js`, E12 |
| P4-012 | Backend waited 300 s for `/embed` and, on timeout, marked the source **failed** while the AI service kept working (and later wrote `ready`); CPU BGE-M3 is slow (measured minutes). Stale-retry window 10 min < indexing time. | **Fixed**: a timeout leaves the source `processing`; stale window 30 min (`SOURCE_STALE_MINUTES`). | `phase4.test.js` |
| P4-013 | No rate limit on cost-bearing endpoints (chat/Pro model, studio, agents, summarize, uploads, URL import, socket chat). | **Fixed**: per-user limits (`CHAT_RATE_LIMIT_PER_MIN` 20, `AI_TOOL_RATE_LIMIT_PER_MIN` 10, `INGEST_RATE_LIMIT_PER_MIN` 30). Memory store unless `RATE_LIMIT_STORE=redis` (compose sets it). | `phase4.test.js` |
| P4-014 | Deleting a workspace removed rows but orphaned every uploaded file in storage. | **Fixed**: files removed after the delete succeeds. | `phase4.test.js` |
| P4-015 | A configured-but-failing GCS bucket silently fell back to container-local disk in production. | **Fixed**: production fails with 503 unless `ALLOW_LOCAL_STORAGE_FALLBACK=true`. | `phase4.test.js` |
| P4-016 | `.env.example` files were **gitignored** (`.env.*`) so never versioned; root one still described Google sign-in/Gemini and omitted every required secret. Compose did not pass `LIVEKIT_*`, `SUPABASE_*`, `GCS_BUCKET_NAME`, `LLM_BASE_URL`. | **Fixed**: un-ignored, rewritten, compose completed. | `docker compose config` [RUN] |
| P4-017 | Containers: root users, `npm install`, backend started with all deps, frontend ran the dev server. | **Fixed** (non-root uid 1000, `npm ci --omit=dev`, production frontend build). All three images build [RUN]. Existing root-owned `uploads_data` volumes need a one-time `chown` (checklist). | image builds + bring-up [RUN] |
| P4-018 | UI hid chat failures (console only) and never displayed `uncited`/warning states. | **Fixed** (error banner; unverified-answer notice; no-source styling from `grounding`). | — (rendering [RUN] in browser) |
| P4-019 | Phase 1 claimed the localStorage token was gone, but `TokenSync` (mounted in `Providers`) still copied the session JWT into `localStorage`. | **Fixed**: now only purges legacy keys. | — |
| P4-020 | Streaming is implemented end to end in the backend (SSE → `chat:delta`) but the web UI uses the REST path and does not render `chat:delta`; on the REST path other members see only the AI reply, not the question, live. | **Open** (feature gap, not a regression). | — |
| P4-021 | Citation *faithfulness* (does the cited chunk actually support the sentence) is not validated; only that citations resolve. Needs a live model and an NLI/LLM judge. | **Open / unverified**. | — |
| P4-022 | Official DeepSeek API (`api.deepseek.com`, ids `deepseek-flash` / `deepseek-v4-pro`) was never called — no key for it exists here; its model ids, `thinking` handling and the `deepseek-v4-pro` aliasing question (third-party claim vs official docs) remain unverified. Only the third-party gateway in P4-032 was exercised live. | **Unverified** — procedure in the checklist. | — |
| **P4-031** | Found with the live model: it duplicated its refusal sentence (`…sources.I could not find…sources.`), which the strict refusal check classified as `uncited` ("unverified") instead of `no_answer`; and in JSON mode it appended junk after a valid object (`{"ok": true}# Benchmark Output …`), which the "first `{` to last `}`" extraction could not parse (studio tools would 502). | [RUN] live probes. | **Fixed**: repeated/whitespace-separated refusals count as refusals and are collapsed; JSON takes the first complete object. | `test_grounding.py`, `test_generator.py` |
| **P4-032** | The live gateway configured in `.env`/`.env.example` (changed by a parallel session, not by Phase 4) sets **`LLM_MODEL_FLASH == LLM_MODEL_PRO == deepseek-ai/DeepSeek-V4-Flash-0731`**, thinking `default`, base URL `https://inference.dahl.global/v1`. With this, "research → V4 Pro" is not in effect (the router still labels tier `pro`; `route.model_used` shows the truth), and the host is a third-party vLLM server, not DeepSeek's API. Observed on it: tiny prompts degenerate (`pongpongpong response…` until `max_tokens`, `finish=length`); `thinking: disabled` made one call take 45 s while enabled took 1.5 s and neither reported `reasoning_tokens`, so the flag appears to be ignored; realistic RAG/JSON prompts stopped normally (`finish=stop`). | [RUN] | **Open — owner decision**: use DeepSeek's own endpoint/models (or confirm the gateway is acceptable), set a distinct Pro model, and re-run the live probe in the checklist. Do not treat this gateway as proof that the required model assignment works. | live probe (checklist §5) |

### Low / informational
| ID | Finding | Status |
|---|---|---|
| P4-023 | `StudyCoachAgent` (ReAct tools take an LLM-chosen `workspace_id`) is constructed at startup but never invoked by any route. It must stay disabled until the id comes from trusted state. | Open (documented; unreachable) |
| P4-024 | Pro→Flash fallback is off by default and reported when on; verified at unit level only. | Verified (mock) |
| P4-025 | `README.md` is 3 lines; `start.sh`/`test.sh` reference a compose `db` service that does not exist. | Open (docs/dev scripts) |
| P4-026 | Tracked CLI scratch (`supabase/.temp`, `.claude/launch.json`); now in `.gitignore`, still tracked. No secrets found. | Open: `git rm --cached` needs owner approval |
| P4-027 | 1 pre-existing ESLint error (`any` in `types/index.ts:88`) plus unfixed `any` use in `lib/api.ts`. `lib/supabase/*` and `NEXT_PUBLIC_SUPABASE_*` are dead code since Google sign-in was removed. | Open (low risk) |
| P4-028 | Dashboard once showed "Backend Server Unavailable" right after the first login in the production stack and did not reproduce on reload (`localhost:4000` reachable from the page by name, IPv4 and IPv6 when checked). Cause not established. | Unverified, not reproduced |
| P4-029 | Sessions are 7-day bearer JWTs with a server-side revocation row; there is no refresh-token flow. Rate-limit counters are per-process unless Redis is configured. | By design; documented |
| P4-030 | Test environment only: Windows Application Control blocked the `uuid_utils` DLL (via langsmith); a test-only shim (`ai/tests/uuid_shim.py`) and `e2e/run_ai.py` work around it. Not needed in the Docker image. | Informational |

## 4. Live database check (read-only)
Project `colab mind` (`kvcyhcedtwktmxmjbrcb`, ap-south-1): migrations applied = `initial_schema` only; RLS enabled on 7 core tables with no policies (deny-all to the public API);
`source_chunks.embedding` is `vector(768)`; **0 rows** in users, workspaces, sources, source_chunks, chat_messages, agent_runs; pgvector installed.
Consequences: the destructive Phase 3 migration would delete nothing there; migrations `20261002000000` … `20261003000000` are **not applied**, so the current backend cannot run against it until they are.
Nothing was applied, altered or written in that project.

## 5. Changes made in Phase 4 (separate from earlier phases' work)
Application: `backend/src/{utils/urlSafety,services/{chatService,sourceService,storageService,workspaceService},controllers/{sourceController,chatController},routes/{chat,agents,sources},middleware/rateLimit,socket/handlers}.js`, `ai/{db.py,rag/extractor.py,agents/study_coach_graph.py}`, `frontend/src/{components/{ChatMessage,ChatInterface,TokenSync},lib/{store,citations,chatMessages},types/index}.ts(x)`.
Database: `supabase/migrations/20261003000000_phase4_integration_fixes.sql` (RLS on 8 tables, `agent_runs.finished_at`, unique hash index; idempotent, additive).
Config/deploy: `docker-compose.yml`, `{backend,ai,frontend}/Dockerfile`, `.env.example`, `.gitignore`.
Tests: `backend/test/{phase4.test,phase4.integration.test,urlSafety.test}.js`, fixes in `chatService.ai.test.js` and `auth.integration.test.js`, `ai/tests/{test_ssrf_guard,test_agent_db}.py`, `frontend/tests/{citations,chatMessages}.test.ts`, `e2e/{e2e.mjs,mock-deepseek.mjs,run_ai.py}`.
Docs: this file, `phase4-test-report.md`, `phase4-deployment-checklist.md`.
Pre-existing uncommitted Phase 3 work (docs, tests, `chatService`/`handlers` streaming, `test_*`) was left as found except where listed above.

## 6. Remaining work (cannot be closed by Phase 4)
1. **Live DeepSeek check** with a real key (checklist §5). 2. **Apply migrations** to the target DB with a backup (checklist §2), then run the reindex script. 3. **Decide** on P4-020 (render streaming in the UI) and P4-021 (faithfulness evaluation). 4. Set real values for `SMTP_URL`, secrets, TLS `NEXTAUTH_URL`/`APP_URL`/`CORS_ORIGINS`. 5. Owner decisions: commit/branch strategy (§7), `git rm --cached` of scratch files, rotate the unused `GEMINI_API_KEY` in local `.env` files. 6. A GPU or hosted BGE-M3 endpoint for realistic indexing speed.

## 7. Git status and proposed commit grouping
Current branch `phase1/auth-security` (HEAD `b6163ee` = `origin/main`). Nothing from Phase 4 is committed. Suggested commits (path-scoped `git add`, never `-A`):
1. `fix(db): RLS on core tables, agent_runs.finished_at, unique upload hash` — the migration, `ai/db.py`, `ai/tests/test_agent_db.py`, `backend/test/phase4.integration.test.js`.
2. `fix(security): IPv6-aware SSRF checks, per-user rate limits, server-side chat history` — `urlSafety`, `rateLimit`, routes, `chatService`, `chatController`, `handlers`, `extractor.py`, related tests.
3. `fix(sources): upload race, slow-embedding status, storage fallback, workspace-delete cleanup` — `sourceService/Controller`, `storageService`, `workspaceService`, `phase4.test.js`.
4. `fix(ui): citation mapping, REST+socket message merge, chat errors, token purge` — frontend files + tests.
5. `chore(deploy): production-mode compose and images, env templates, gitignore` — compose, Dockerfiles, `.env.example`, `.gitignore`.
6. `test(e2e): full-stack acceptance run` — `e2e/`.
7. `docs: phase 3 and 4 reports` — `docs/phase3-*.md`, `docs/phase4-*.md` (and the earlier untracked phase docs).
