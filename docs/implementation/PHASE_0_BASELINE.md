# CollabMind — Phase 0 Baseline

Date: 2026-10-02 · Branch: `main` @ `4e58f32` · Author: Phase 0 coordinator (read-only audit)

**Legend** — every statement is tagged:
- **[VERIFIED]** I ran a command or opened the file and saw it.
- **[INSPECTED]** Read from source code only; behavior was *not* executed.
- **[NOT RUN]** Check was skipped or did not finish; no claim is made about it.

No application code, manifests, or dependencies were modified. The only files created are the two documents in `docs/implementation/`.

---

## 1. Repository state

**[VERIFIED]** 3 commits on `main` (`b4de9a0` first commit → `2de1477` → `4e58f32`). The working tree is **dirty with 50 entries**: 19 tracked files modified (209 insertions / 244 deletions) and ~31 untracked paths. None of it is committed. Nothing was reverted, stashed, or touched.

This uncommitted work is substantial and is the *de facto* current product, so treat it as live work from other agents/people:

| Area | Uncommitted change |
|---|---|
| AI / RAG | `ai/rag/embedder.py` rewritten (−305/+ lines); new `ai/rag/extractor.py` (MarkItDown), `ai/rag/chunker.py`; `db.py` `ensure_schema`; `ai/tests/` (3 files), `pytest.ini`, `requirements-dev.txt`, `THIRD_PARTY_NOTICES.md` |
| Backend sources | `sourceController.js`, `middleware/upload.js` (extension allow-list), `middleware/authenticate.js` (demo-token gating) |
| Backend messaging/calls (new) | `routes/{conversations,calls,users}.js`, `controllers/{conversation,call}Controller.js`, `services/{conversation,message,call,livekit,chatStorage,realtime}Service.js`, `socket/messaging.js`, `middleware/chatUpload.js`, `config/demoAuth.js`, `utils/http.js`, `test/messaging.test.js` |
| Frontend messaging (new) | `components/messaging/*` (11 files), `hooks/MessagingProvider.tsx`, `lib/messaging{Api,Utils}.ts`, `store/messagingStore.ts`, `types/messaging.ts` |
| DB | `supabase/migrations/20261002000000_messaging_and_calls.sql` (new), `migration.sql` (+1 line: `location_label`) |
| Infra | `docker-compose.yml` (28 lines), `backend/package.json` (adds `test` script), `ai/requirements.txt` |
| Docs | `docs/CollabMind — Final-Year Project Audit.docx` (untracked; not read) |

Other **[VERIFIED]** observations:
- `.claude/` contains `launch.json` (frontend dev server on :3000) and `scheduled_tasks.lock` (a live session lock, pid 9020) — another Claude session may be active in this tree.
- Git reports LF→CRLF warnings on every modified file (Windows `autocrlf`). Expect noisy whole-file diffs if agents save with different line endings.
- `supabase/.temp/start-secrets/.../index.ts` and `supabase/.temp/pgdelta/*.json` are **tracked in git**. I did not open them. They are local Supabase CLI scratch output and should be reviewed for secrets and untracked (see Defect D-12).
- `.env` (root) and `ai/.env` exist locally and are git-ignored. **I did not read them.** `.env.example` is ignored by the `.env.*` pattern, so it is not tracked either.

## 2. Architecture (current)

```
Browser ── Next.js 16 (frontend :3000, React 19, Tailwind 4, zustand, shadcn/base-ui)
   │  auth: next-auth v5 beta + Supabase SSR helpers; API token kept in localStorage
   │  REST  ──────────────► Express 4 backend (:4000) ── pg ──► PostgreSQL + pgvector (Supabase)
   │  Socket.IO ──────────►   • JWT auth (own HS256 secret) + demo-token escape hatch
   │                          • Socket.IO + Redis adapter, Redis pub/sub bridge
   │                          • Messaging/calls: conversations, messages, LiveKit tokens (hand-signed JWT)
   │                          • Files: multer (memory) → GCS, else local disk (/app/uploads)
   │                          • Chat attachments → Supabase Storage (private bucket `chat-files`, service-role key)
   │                          └─ axios ─► FastAPI AI service (:8000) ── asyncpg ─► same Postgres
   │                                      • /embed (MarkItDown → chunker → Gemini embed → pgvector)
   │                                      • /chat RAG, /studio/*, /agents/study-coach (LangGraph)
   │                                      • Redis: agent approval flags + `ai_updates` pub/sub
   └─ LiveKit (WebRTC) direct from browser using backend-issued token
Redis 7 (docker) shared by backend + AI.
```

**[INSPECTED]** key facts:
- Two JWT worlds: backend-signed HS256 token (`JWT_SECRET`) from `/api/auth/google` and `/api/auth/email`; and a Supabase/next-auth session on the frontend. The bridge is `TokenSync.tsx` writing `localStorage.supabase_auth_token`; `frontend/src/lib/api.ts` falls back to the literal token `demo-guest-token`.
- Realtime: workspace rooms (`workspace:<id>`) + a separate messaging channel enabled by `?scope=messaging`.
- Storage is three-way: GCS (`gs://`), local volume (`local://`), Supabase Storage (chat only).
- Embedding dimension is fixed at `vector(768)` (`text-embedding-004`). Generation model is `gemini-1.5-flash`.
- Schema source of truth is ambiguous: `migration.sql` (root, Docker-era), `supabase/migrations/20260807…initial_schema.sql`, `supabase/migrations/20261002…messaging_and_calls.sql`, and `ai/db.py::ensure_schema()` (runtime `ALTER`).

### Repository map

| Path | Purpose |
|---|---|
| `frontend/` | Next.js app. Routes in `src/app`; workspace pages `workspace/[id]/{chat,members,sources,studio}`; shared UI in `components/`; stores in `store/` and `lib/store.ts`; API wrapper `lib/api.ts` + `lib/messagingApi.ts`. Has `AGENTS.md` warning that this Next version has breaking changes — read `node_modules/next/dist/docs/` before writing Next code. |
| `backend/` | Express entry `index.js`; `src/{routes,controllers,services,middleware,socket,db,config,utils}`; tests in `test/`. |
| `ai/` | FastAPI `main.py`; `rag/{embedder,extractor,chunker,retriever,pipeline,generator}.py`; `agents/` (study coach, LangGraph); `db.py`, `redis_client.py`, `schemas.py`; `tests/`. |
| `supabase/` | `config.toml`, 2 migrations, plus tracked `.temp/` and `.branches/` CLI scratch. |
| Root | `docker-compose.yml`, `migration.sql`, `seed.sql`, `start.sh`, `test.sh`, `.env.example`, `README.md` (3 lines), `docs/` (reports, decks, `collabmind_4sprints.html`). |
| Deployment | **No CI** (`.github/` absent). Dockerfiles for all three services. Compose runs redis + ai + backend + frontend; **no Postgres service** (DB is remote Supabase via `DATABASE_URL`). |

## 3. Baseline check results

Environment **[VERIFIED]**: Windows 11, Node v24.19.0, npm 11.17.0, Python 3.14.6 (a `ai/.venv` exists), pytest 9.0.3 importable, Docker 29.7.2 / Compose v5.4.0. `node_modules` is present in `frontend/` and `backend/`.

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Docker config validation | `docker compose config -q` (repo root) | **PASS** — exit 0, no output **[VERIFIED]**. Validates syntax only, not that images build or services start. |
| 2 | Frontend type-check | `npx tsc --noEmit` in `frontend/` | **[NOT RUN → no result]** First attempt hit my 600 s timeout with empty output (exit 124); re-run is in the table at §3.2. |
| 3 | Frontend lint | `npx eslint .` in `frontend/` | **[NOT RUN → no result]** Same: exit 124, empty output. |
| 4 | Backend tests | `npm test` (`node --test "test/**/*.test.js"`) | **[NOT RUN → no result]** Exit 124 after 300 s, no test output. |
| 5 | Backend lint | — | **[NOT RUN]** Backend has no lint script or ESLint config. |
| 6 | Python tests | `python -m pytest -q` in `ai/` | **[NOT RUN → no result]** Exit 124 after 600 s, no output (not even a collection line). |
| 7 | Frontend tests | — | **[NOT RUN]** No test script and no test files in `frontend/`. |
| 8 | Integration `test.sh` | — | **[NOT RUN]** Needs live DB/Redis/backend/AI and refers to a `db` compose service that does not exist (see D-11). |

### 3.1 Why checks 2–4 and 6 produced no result (blocker)

**[VERIFIED]** Any `node` process that `require()`s a package from `backend/node_modules` stalls: `node -e "console.log('hi')"` returns in 0.25 s, but `node -e "require('ms')"` (a 1-file package) did not finish in 20–30 s, with `sys` time ≈ 7.7 s and `user` ≈ 0.25 s. Python/pytest and `tsc`/`eslint` stalled the same way. The Read tool opens the same files instantly, so the files are not corrupt.

**[Hypothesis, not confirmed]** On-access antivirus scanning of `G:\` (the drive root contains `#0eScanProtected.docx`, suggesting eScan) makes loading many small files from `node_modules`/`site-packages` extremely slow. **Do not conclude the code is broken from these timeouts; do not conclude it is healthy either.** The next phase should either exclude the repo from AV scanning, run checks from a copy on `C:\`, or run them in WSL/Docker. I did not change any system setting.

### 3.2 Re-run (sequential, one at a time, 420 s cap each)

| Check | Outcome |
|---|---|
| Backend `node --test --test-force-exit test/messaging.test.js` | **No result** — killed at the cap (exit 124, 470 s, zero output). Same stall as §3.1. |
| `ai`: `python -m pytest -q` | **Ran, collection failed (exit ≠ 0)** — both test modules error with `ModuleNotFoundError: No module named 'markitdown'`. The interpreter used was Anaconda Python 3.14 (`C:\Users\meshi\anaconda3`), **not** `ai/.venv`, so this shows the *global* environment lacks the new dependency; it does not show the tests fail in the project venv. Re-run with `ai/.venv` (or after `pip install -r requirements-dev.txt`). No tests executed. |
| Frontend `npx tsc --noEmit` | **Not finished when this document was written** (job still running, capped at 420 s). Treat as no result. Expected to report the missing `livekit-client` module (D-04, **[INSPECTED]**). |
| Frontend `npx eslint .` | **Not run in the re-run** (queued behind tsc); the first attempt timed out (exit 124). No result. |

Net: **no test, lint, or type-check has been verified as passing.** The only verified pass is `docker compose config -q`.

## 4. Existing functionality

**[INSPECTED]** unless noted.

- Auth: Google ID-token login → JWT; email login → JWT; demo tokens (`demo-*`, `test-token`, `mock-token-for-testing`) map to a shared demo user, allowed unless `NODE_ENV=production` and `ALLOW_DEMO_AUTH!=true`.
- Workspaces + members + roles (`requireWorkspaceMember`, `requireRole`).
- Sources: upload (pdf/docx/pptx/xlsx/xls/txt/md/csv/html/json, 50 MB), URL, YouTube-typed URL; async embedding; `source:ready|failed` pushed over Redis→Socket.IO; summarize endpoint.
- RAG chat with citations and location labels; workspace chat persisted in `chat_messages`.
- Studio: flashcards, quiz, study guide, report. Study-coach LangGraph agent with approve/status.
- Messaging: direct + group conversations, read pointers, attachments (signed URLs), presence/typing, audio/video calls via LiveKit with ringing/missed/declined lifecycle and a sweeper.
- Tests that exist: `backend/test/messaging.test.js` (stubs the pg pool), `ai/tests/test_{embedder,extractor}.py`. None are verified to pass (see §3).

## 5. Known defects and risks

Severity: **H** = security / data-loss / blocks build, **M** = correctness, **L** = hygiene. All are **[INSPECTED]** unless stated; none were reproduced.

| ID | Sev | Finding | Location |
|---|---|---|---|
| D-01 | H | `POST /api/auth/email` mints a valid 7-day JWT for **any** email with no verification or secret. Anyone can sign in as any user, including a workspace owner. It also falls back to a hard-coded secret `super_secret_jwt_key_123` if `JWT_SECRET` is unset. | `backend/src/controllers/authController.js:33`, `services/authService.js:71-91`, `routes/auth.js:12` |
| D-02 | H | Socket `workspace:join_request` **inserts the caller into `workspace_members` and sets `socket.role='owner'`** for any `workspaceId` — a membership bypass that also feeds REST authorization. It also upserts a user row named "Demo Researcher" with the caller's id. | `backend/src/socket/index.js:76-101` |
| D-03 | H | Socket auth silently falls back to the shared demo user on a bad/expired JWT; the frontend defaults to token `demo-guest-token`. In non-production (the default) every request is the same user. | `socket/index.js:30-66`, `middleware/authenticate.js`, `frontend/src/lib/api.ts:5` |
| D-04 | H | **Frontend imports `livekit-client`** (`CallRoom.tsx:4`) but it is **absent from `frontend/package.json` and `node_modules`** **[VERIFIED]**. `next build`/`tsc` should fail. | `frontend/package.json` |
| D-05 | H | Agent routes validate workspace membership but pass `runId` straight to the AI service without checking the run belongs to that workspace — a member of workspace A can read/approve workspace B's runs by id. AI service endpoints have no auth at all and port 8000 is published by compose. | `backend/src/routes/agents.js:30-51`, `ai/main.py:114-174`, `docker-compose.yml` |
| D-06 | H | `findOrCreateUser` writes `users.google_id` and `updated_at`, but neither migration defines those columns, so Google login would fail on a DB built from the repo's migrations (live Supabase DB may differ — **not checked**). | `authService.js:48-57` vs both schema files |
| D-07 | M | Embedding fallback: when Gemini is unavailable or the key starts with `dummy`, both embedder and retriever silently substitute a SHA-256-derived pseudo-vector. Chunks embedded during an outage are semantically meaningless yet stored alongside real ones, and retrieval then returns arbitrary chunks. | `ai/rag/embedder.py:72-89`, `retriever.py:34-39` |
| D-08 | M | Model names may be retired/stale (`gemini-1.5-flash`, `models/text-embedding-004`, 768-dim schema). Needs verification against current Google docs before any RAG work. | `ai/rag/pipeline.py:12`, `embedder.py:21` |
| D-09 | M | `sendChatMessage` holds a pooled pg connection and an open transaction for up to 30 s while waiting on the AI service; the user message is rolled back on AI failure. Socket `chat:message` also drops `conversation_history`. | `backend/src/services/chatService.js:55-114`, `socket/handlers.js:31` |
| D-10 | M | Backend test hangs on `node --test` in this environment (see §3.1). Independently, `require('../src/services/…')` pulls in `db/redis.js` (ioredis connects at import) which will keep `node --test` alive without `--test-force-exit` unless stubbed. **[Hypothesis]** | `backend/src/db/redis.js` |
| D-11 | M | Compose/scripts drift: `start.sh`/`test.sh` call `docker-compose … db` but there is no `db` service; compose does not pass `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LIVEKIT_*`, `GCS_BUCKET_NAME`, `NODE_ENV`, `ALLOW_DEMO_AUTH`, or `NEXT_PUBLIC_SUPABASE_*` into containers, so attachments, calls and Google sign-in cannot work under Docker. Insecure default secrets (`super_secret_jwt_key_123`, `super_secret_nextauth_key_123`). | `docker-compose.yml`, `start.sh`, `test.sh`, `.env.example` |
| D-12 | M | `supabase/.temp/**` and `.branches/` are tracked in git (CLI scratch, may contain secrets). `CORS` is `*` for both Express and Socket.IO. `/api/auth/*` has no rate limiting. | `git ls-files`, `backend/index.js:28`, `socket/index.js:17` |
| D-13 | M | Four schema sources (see §2) can disagree; `source_chunks.location_label` exists only in root `migration.sql` and in `ai/db.py::ensure_schema`, not in `supabase/migrations`. HNSW index is `WHERE workspace_id IS NOT NULL`, which does not isolate tenants as its comment claims. | `migration.sql`, `supabase/migrations/*`, `ai/db.py` |
| D-14 | L | The summarize endpoint forwards `sourceId` to the AI service without verifying it belongs to the workspace in the URL (the AI side may scope by workspace — **not checked**). | `sourceController.js:101-113` |
| D-15 | L | No CI, no backend lint, no frontend tests, 3-line README, `next-env.d.ts`/`tsconfig.tsbuildinfo` present in the tree. Large number of `any` casts in `frontend/src/lib/api.ts`. | repo-wide |

Positive findings **[INSPECTED]**: SSRF guard in `extractor.py` (blocks private/loopback/link-local, no redirects), local-file path allow-list in `embedder.py`, UUID param validation and RLS-on-with-no-policies for the messaging tables, demo auth gated for production, LiveKit tokens minted only server-side.

## 6. Not examined (explicitly out of scope for Phase 0)

`backend/src/{controllers,services,routes}` for workspaces/members, `callService`/`messageService`/`conversationService` internals, `ai/agents/*`, `ai/rag/generator.py`, all frontend pages/components other than those named above, the root `.env` files, the live Supabase project state (migrations applied or not), and the `.docx` audit file. No claims are made about them.

## 7. Recommended next steps

1. Fix the tooling blocker (§3.1) so Phase 1 can get real pass/fail signals; re-run §3 and update this file.
2. Add `livekit-client` to `frontend/package.json` (owned by Task T0) — this is the only item known to block `next build`.
3. Do the security block (T1) before adding features — D-01/D-02/D-03/D-05 are exploitable today.
4. Decide the single schema source of truth (T2) before anyone adds more migrations.
5. See `AGENT_TASK_OWNERSHIP.md` for who touches which files and in what order.
