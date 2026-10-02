# CollabMind — Agent Task Ownership & Execution Plan

Companion to `PHASE_0_BASELINE.md` (defect IDs `D-xx` refer to it). The task list below is **proposed by Phase 0 from the repository audit**; no later-phase requirements were provided, so adjust the task list if the product roadmap differs. Ownership rules and conflict analysis hold regardless.

## 1. Ground rules for every agent

1. **Preserve the architecture**: Next.js frontend, Express backend, FastAPI AI service, PostgreSQL + pgvector, GCS/local/Supabase Storage. No framework swaps.
2. **Uncommitted work is live.** ~50 paths are modified/untracked (baseline §1). Before editing any file, run `git status -- <path>` and `git diff -- <path>`; build on the working-tree content, never on `HEAD`. Never `git checkout`, `git restore`, `git stash`, `git reset`, or `git clean`.
3. **Only edit files you own** (§3). Need a change in someone else's file? Put it in the *Handoff requests* list (§8) or wait for the owner's merge point.
4. **Shared files (§4) are edited only by their designated owner**, in the order given. Everyone else asks via handoff.
5. **Don't reformat.** The tree has LF/CRLF churn; keep each file's existing line endings and style so diffs stay minimal.
6. **Commit per task**, small and path-scoped (`git add <owned paths>` — never `git add -A`). Do not commit `.env*`, `supabase/.temp/**`, or `.claude/`.
7. **Environment**: node/python/tsc runs stall on this machine (baseline §3.1). Agents should run checks from a location/shell where they complete, and report exact commands + outcomes — never claim a check passed that did not run.
8. `frontend/AGENTS.md` applies: read `frontend/node_modules/next/dist/docs/` before writing Next.js code.

## 1a. Already in flight (reported by another session, not verified by Phase 0)

A session named "CollabMind Phase 1 security" messaged during Phase 0 that it is **already doing T1** and that:
- New required env vars: backend `JWT_SECRET` (≥32 chars, placeholders rejected), `AI_SERVICE_TOKEN`, `REDIS_PASSWORD`, `CORS_ORIGINS`; ai `AI_SERVICE_TOKEN`; mail uses `SMTP_URL`, `MAIL_FROM`. docker-compose will stop shipping default secrets; Redis gets a password and binds to 127.0.0.1.
- It will add `backend/test/auth*.test.js` and `ai/tests/test_service_auth.py`.
- `supabase/migrations/20261002010000_auth_security_consistency.sql` is declared canonical; root `migration.sql` is not being edited and has drifted.

Implications: T1 is **claimed** — do not start it separately; T2 must take that migration as input rather than redo schema work; T7 must adopt the new env vars (and Phase 1 is touching `docker-compose.yml`, so coordinate before T7 edits it); T3 gets its service-secret contract from `AI_SERVICE_TOKEN`. Re-run `git status` before relying on §3 file lists — they reflect the tree at Phase 0 time.

## 2. Tasks

| ID | Task | Why (baseline ref) |
|---|---|---|
| **T0** | Tooling & CI baseline | D-04, D-10, D-15, §3.1 |
| **T1** | Authentication & authorization hardening | D-01, D-02, D-03, D-05, D-12, D-14 |
| **T2** | Schema consolidation & migrations | D-06, D-13 |
| **T3** | RAG / AI service correctness | D-07, D-08, D-09 (AI side) |
| **T4** | Sources pipeline (upload → extract → embed → UI) | uncommitted extractor/upload work |
| **T5** | Messaging & calls hardening | uncommitted messaging/LiveKit work |
| **T6** | Workspace chat, studio, agents (frontend + backend glue) | D-09 (backend side) |
| **T7** | Docker, env, deployment config | D-11, D-12 |
| **T8** | Integration & regression suite | all |

## 3. File ownership

`*` = new/modified and **uncommitted** today (owner must preserve working-tree content).

### T0 — Tooling & CI
Owns: `frontend/package.json`, `frontend/package-lock.json`, `backend/package-lock.json`, `frontend/eslint.config.mjs`, `frontend/tsconfig.json`, new `backend/eslint.config.*`, new `.github/workflows/*`, `ai/pytest.ini`*, `ai/requirements-dev.txt`*, `.gitignore`.
`backend/package.json`* — T0 owns **scripts/devDependencies**; T5 may add runtime deps only through handoff.
Acceptance:
- `livekit-client` added to `frontend/package.json` with lockfile updated; `tsc --noEmit` has no *missing module* error.
- A documented way to run all four checks (frontend lint/tsc, backend test, ai pytest, `docker compose config -q`) that completes on the dev machine; results recorded in `docs/implementation/CHECK_RESULTS.md`.
- `npm test` in `backend/` exits on its own (no hang; stub or close Redis/pg handles).
- CI workflow runs the same four checks.
- `supabase/.temp/**` removed from the index via `git rm --cached` (T0 does this only after T1 confirms no secret needs rotating) and added to `.gitignore`.

### T1 — Auth & authorization
Owns: `backend/src/controllers/authController.js`, `backend/src/services/authService.js`, `backend/src/routes/auth.js`, `backend/src/middleware/{authenticate,requireRole,requireWorkspaceMember}.js`*, `backend/src/config/demoAuth.js`*, `backend/src/socket/index.js`* (**auth middleware + `workspace:join_request` only**), `backend/src/routes/agents.js`, `backend/src/controllers/sourceController.js`* (**summarize ownership check only; T4 owns the rest of that file**), `frontend/src/lib/api.ts` (token handling only), `frontend/src/components/TokenSync.tsx`, `frontend/src/auth.ts`, `frontend/src/proxy.ts`, `frontend/src/app/auth/**`, `frontend/src/app/api/auth/**`.
Acceptance:
- `/api/auth/email` cannot mint a token for an unverified email (remove, or require proof of ownership); no hard-coded JWT secret fallback anywhere — startup fails if `JWT_SECRET` is unset.
- `workspace:join_request` verifies existing membership and **never inserts**; role comes from DB, not `'owner'`.
- Socket and REST reject invalid/expired tokens (no silent demo fallback outside explicit `ALLOW_DEMO_AUTH`).
- Agent `status`/`approve` verify the run's `workspace_id` equals the URL's; summarize verifies the source belongs to the workspace.
- Service-to-service auth between backend and AI service (shared secret header) agreed with T3/T7.
- Tests added under `backend/test/auth*.test.js` covering the four defects above.

### T2 — Schema & migrations
Owns: `migration.sql`*, `seed.sql`, everything under `supabase/migrations/`, `supabase/config.toml`, `ai/db.py`* (**`ensure_schema` only**).
Acceptance:
- One documented source of truth; a fresh database built from it supports every query in `backend/src` and `ai/` (specifically `users.google_id`, `users.updated_at`, `source_chunks.location_label`).
- New migrations are additive and idempotent; the existing `20261002…messaging_and_calls.sql`* is not edited, only superseded by newer files.
- `ensure_schema` reduced to a safety net or removed once migrations cover it.
- Tenant isolation of the vector index/queries reviewed and documented (D-13).
- Applying to the remote Supabase project is **not** done by agents without explicit user approval.

### T3 — RAG / AI service
Owns: `ai/rag/{retriever,pipeline,generator,embedder}.py`*, `ai/rag/__init__.py`, `ai/agents/**`, `ai/redis_client.py`, `ai/schemas.py`* , `ai/main.py`* (**endpoint auth + wiring; T4 owns `/embed` handler body**), `ai/tests/test_{retriever,pipeline,generator}*.py` (new).
Acceptance:
- Current Gemini model IDs verified against docs and made configurable by env var; embedding dimension matches the schema.
- No silent pseudo-embedding fallback in production: failures surface as `failed` source status / explicit chat error; the dev fallback is behind an explicit env flag and never mixes with real vectors.
- Retrieval always filters by `workspace_id`; covered by a test.
- Endpoints require the service-secret header from T1/T7; `/health` stays open.
- `pytest` passes in `ai/` (record exact command + output).

### T4 — Sources pipeline
Owns: `backend/src/controllers/sourceController.js`*, `backend/src/services/{sourceService,storageService}.js`, `backend/src/routes/sources.js`, `backend/src/middleware/upload.js`*, `ai/rag/{extractor,chunker}.py`*, `ai/tests/{test_extractor,test_embedder,conftest}.py`*, `ai/requirements.txt`*, `ai/THIRD_PARTY_NOTICES.md`*, `frontend/src/app/workspace/[id]/sources/page.tsx`*, `frontend/src/components/{SourceUploader,CitationPanel}.tsx`*.
Handoffs: `embedder.py` is T3-owned but T4 may edit **only `load_blocks` / `_read_*` / extraction call sites**; coordinate via §8.
Acceptance:
- Upload → `processing` → `ready|failed` works for each allowed type (pdf, docx, pptx, xlsx, xls, csv, html, md, json, txt) with fixtures built in tests (no committed binaries).
- Failure modes (oversize, bad type, unreadable, SSRF URL, path outside `UPLOADS_DIR`) return safe messages and `failed` status.
- UI shows live status via the existing `source:*` socket events and renders `location_label` in citations.
- `ai/requirements.txt` pins documented; `THIRD_PARTY_NOTICES.md` current.

### T5 — Messaging & calls
Owns: `backend/src/routes/{conversations,calls,users}.js`*, `backend/src/controllers/{conversation,call}Controller.js`*, `backend/src/services/{conversation,message,call,livekit,chatStorage,realtime}Service.js`* (+ `chatStorage.js`, `realtime.js`), `backend/src/socket/messaging.js`*, `backend/src/middleware/chatUpload.js`*, `backend/src/utils/http.js`*, `backend/test/messaging.test.js`*, `frontend/src/components/messaging/**`*, `frontend/src/hooks/MessagingProvider.tsx`*, `frontend/src/lib/{messagingApi,messagingUtils}.ts`*, `frontend/src/store/messagingStore.ts`*, `frontend/src/types/messaging.ts`*, `supabase/migrations/20261002…messaging_and_calls.sql`* (read-only; changes go to T2).
Acceptance:
- Membership is enforced on every REST and socket path (tests for non-member read/send/join-call/token).
- LiveKit token only for call participants; call lifecycle (ring → active → ended / missed / declined) and the sweeper covered by tests.
- Attachments: type allow-list, size cap, signed-URL TTL verified.
- Frontend builds once `livekit-client` is present (T0); no `any` leaks in the new messaging types.
- Tests pass with the pg pool stubbed (no DB required).

### T6 — Workspace chat, studio, agents
Owns: `backend/src/services/chatService.js`, `backend/src/controllers/chatController.js`, `backend/src/routes/chat.js`, `backend/src/socket/handlers.js`, `backend/src/services/{agentSubscriber,pubsubService}.js`, `frontend/src/app/workspace/[id]/{chat,studio}/**`, `frontend/src/components/{ChatInterface,ChatMessage}.tsx`, `frontend/src/components/studio/**`, `frontend/src/store/chatStore.ts`, `frontend/src/hooks/{SocketProvider.tsx,useSocket.ts}`.
Acceptance:
- Chat no longer holds a DB transaction/connection across the AI call; socket path forwards conversation history.
- AI failures show a clear UI error and don't lose the user's message.
- Studio tools and agent approve/status flow work end to end against a stubbed AI service.

### T7 — Docker, env, deployment
Owns: `docker-compose.yml`*, `*/Dockerfile`, `*/.dockerignore`, `.env.example`, `start.sh`, `test.sh`, `README.md`, `ai/.env.example`.
Acceptance:
- Compose passes every env var the code reads (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LIVEKIT_*`, `GCS_BUCKET_NAME`, `UPLOADS_DIR`, `ALLOW_DEMO_AUTH`, `NODE_ENV`, `NEXT_PUBLIC_SUPABASE_*`, the service secret).
- No default secrets in compose; missing required secrets fail loudly.
- `start.sh`/`test.sh` reference only services that exist.
- AI port not published to the host unless explicitly overridden.
- `docker compose config -q` passes; README documents local setup, env vars, and how to run each check.

### T8 — Integration & regression
Owns: new `docs/implementation/CHECK_RESULTS.md`, new top-level `e2e/` or `test/integration/` (new files only). Edits **no** application code.
Acceptance: see §6.

## 4. Shared / high-conflict files

| File | Why it conflicts | Single owner | Others must |
|---|---|---|---|
| `backend/index.js`* | Router mounts, middleware order, startup | **T1** (CORS/helmet/rate limit) → then T5 for mounts | handoff |
| `backend/src/socket/index.js`* | Auth middleware, workspace join, messaging registration | **T1** | T5/T6 add handlers in their own files (`messaging.js`, `handlers.js`) |
| `backend/src/middleware/authenticate.js`* | Every route depends on it | **T1** | read-only |
| `backend/package.json`* / `frontend/package.json` + lockfiles | Dependency adds collide, lockfile merges are unmergeable | **T0** | handoff dependency requests |
| `docker-compose.yml`*, `.env.example` | Env vars from every task | **T7** | handoff env vars |
| `migration.sql`*, `supabase/migrations/**` | Schema ordering and timestamps | **T2** | handoff DDL; never add migrations directly |
| `ai/main.py`* | All AI endpoints + lifespan | **T3** (T4 only `/embed` body) | handoff |
| `ai/schemas.py`* | Shared request/response models | **T3** | handoff new models |
| `ai/rag/embedder.py`* | T3 (embedding) vs T4 (extraction) | **T3**, T4 limited to load/extract functions | handoff |
| `ai/requirements.txt`* | Python deps | **T4** (extraction) — T3 via handoff | handoff |
| `frontend/src/types/index.ts`* | Shared FE types | **T6** | new types go in feature files (`types/messaging.ts`) |
| `frontend/src/lib/api.ts` | Every FE feature calls it | **T1** (token handling), additive exports by T4/T6 appended at end of file | rebase before commit |
| `frontend/src/lib/store.ts`, `store/workspaceStore.ts`, `components/Providers.tsx`, `app/layout.tsx` | Provider wiring | **T6**; T5 registers `MessagingProvider` via handoff | handoff |
| `frontend/src/app/workspace/[id]/layout.tsx` | Nav + providers for all workspace pages | **T6** | handoff |
| `backend/src/db/{postgres,redis}.js` | Pool/Redis handles used by tests (D-10) | **T0** | handoff |
| `README.md`, `docs/implementation/*` | Docs | **T7** (README); each task appends only to its own section in `docs/implementation/<TASK>_NOTES.md` | — |

## 5. Dependencies between tasks

```
T0 ──► T5 (frontend builds) ──┐
T0 ──► T8                      │
T1 ──► T3 (service secret) ────┤
T1 ──► T6, T5 (auth contract)  ├──► T8
T2 ──► T3, T4, T5 (schema)  ───┤
T3 ◄──► T4 (embedder split)    │
T7 ◄── env var requests from all
```
Hard dependencies: **T2 before any task that adds a column** (T3/T4/T5); **T1 defines the service-secret header** consumed by T3 and T7; **T0 must land `livekit-client`** before T5's frontend can be type-checked.

## 6. Recommended execution order

| Wave | Tasks | Parallel? | Gate to leave the wave |
|---|---|---|---|
| **0** | T0 (tooling) and T1 (security) | Yes, disjoint files | Checks run to completion locally; D-01/02/03/05 closed with tests |
| **1** | T2 (schema) | Alone for its first day; short | A fresh DB from migrations supports all queries; handoff DDL requests drained |
| **2** | T3, T4, T5, T6 | Yes — disjoint ownership except the `embedder.py` T3/T4 split and `package.json` handoffs | Each task's acceptance tests pass |
| **3** | T7 (deploy config) | Can start in wave 2 for compose/env, finalizes after | `docker compose config -q` passes; env table complete |
| **4** | T8 (integration) | Alone | See regression plan |

## 7. Integration and regression plan

After each wave, T8 (or the coordinating agent) runs, from a clean checkout of the merged tree:

1. `docker compose config -q`
2. `cd backend && npm test`
3. `cd frontend && npx tsc --noEmit && npx eslint .` (and `next build` after Wave 2)
4. `cd ai && python -m pytest -q`
5. Smoke (with docker compose up, stubbed Gemini): login → create workspace → upload each file type → source reaches `ready` → ask a question → answer has citations with `location_label` → run a studio tool → start study-coach, approve, poll status.
6. Messaging smoke: two users, direct + group message, attachment, read receipt, call ring/answer/decline, non-member denied.
7. Security regression: forged email login rejected; non-member socket join rejected; cross-workspace agent run id rejected; AI service rejects calls without the secret; demo token rejected when `NODE_ENV=production`.
8. Diff hygiene: `git status` shows no `.env*`, `supabase/.temp`, or unrelated files; no file outside its owner's list changed (compare against §3).

Record every command and result in `docs/implementation/CHECK_RESULTS.md`; mark skipped checks with the reason.

## 8. Handoff requests (append-only)

Agents add one line per cross-ownership request: `[from Tx → Ty] file — change needed — why`.

- _(none yet)_
- Seed entries from Phase 0:
  - `[T5 → T0]` add `livekit-client` to `frontend/package.json` (D-04).
  - `[T3 → T1]` define the service-to-service auth header name and env var.
  - `[T3, T4, T5 → T2]` any new column/table DDL.
  - `[all → T7]` any new environment variable.
