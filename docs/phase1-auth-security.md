# Phase 1 — Authentication, authorization, schema and AI-service security

Branch: `phase1/auth-security`. Canonical schema: `supabase/migrations/` (root `migration.sql` had already drifted from it and is untouched).

## 1. What changed

### Email-only authentication (backend is the authority)
| Endpoint | Auth | Result |
|---|---|---|
| `POST /api/auth/register` `{email,password,name}` | none | `202` always the same body (no account enumeration). Creates an **unverified** account and mails a verification link. A verified account is never modified by a register call. |
| `POST /api/auth/verify-email` `{token}` | none | `200`, or `400 {code:'INVALID_TOKEN'}`. Tokens are single-use, 24 h. |
| `POST /api/auth/resend-verification` `{email}` | none | `202` generic. |
| `POST /api/auth/login` `{email,password}` | none | `200 {token, expiresAt, user}`; `401 INVALID_CREDENTIALS` (same for unknown email/wrong password, timing-equalised); `403 EMAIL_NOT_VERIFIED`; `429`. |
| `POST /api/auth/logout` | Bearer | `204`; revokes the server-side session and disconnects its sockets. |
| `GET /api/auth/me` | Bearer | `200 {user}`. |
| `POST /api/auth/forgot-password` `{email}` | none | `202` generic. |
| `POST /api/auth/reset-password` `{token,password}` | none | `200`; sets password, marks email verified (mailbox proof), revokes **all** sessions. Token is 1 h, single-use, not consumed by a weak password. |

Removed: `POST /api/auth/google`, `POST /api/auth/email` (passwordless token minting), demo/guest tokens, `config/demoAuth.js`, the Google button, the "1-Click Quick Demo" button, the Supabase OAuth callback route.

* Passwords: scrypt (N=2^16, r=8, p=2, per-user salt, parameters stored in the hash), min 10 / max 128 chars.
* Session token: JWT HS256 with `iss=collabmind-api`, `aud=collabmind-app`, `sub=<user id>`, `jti=<session id>`, `exp` (`JWT_EXPIRES_IN`, default 7d, max 30d). **Also** backed by a row in `auth_sessions`; `authenticate` checks signature, algorithm, issuer, audience, expiry, session not revoked/expired, and email still verified.
* `req.user = { id, email, name, sessionId }` — JWT claims are no longer spread into it. `socket.user = { id, email, name }`.
* Rate limits (per IP and per account; memory store, or Redis with `RATE_LIMIT_STORE=redis`): login 30/15 min per IP and 10/15 min per email; register 10/h per IP; resend/forgot 20/h per IP and 5/h per email; verify/reset 30/15 min per IP. `429 {code:'RATE_LIMITED'}` + `Retry-After`.
* Errors: 5xx responses are generic (`Internal server error`), details are logged server-side only.
* Fail-fast config (`src/config/env.js`): refuses to start with missing/short/placeholder `JWT_SECRET` or `AI_SERVICE_TOKEN`, wildcard `CORS_ORIGINS`, or production without `SMTP_URL`.
* CORS (REST and Socket.io) is an explicit allow-list (`CORS_ORIGINS`), not `*`.

### Frontend
`auth.ts` (NextAuth Credentials → `/api/auth/login`, no Google, no offline demo fallback, session `maxAge` 7d, backend logout on sign-out), `lib/authToken.ts` (`getAccessToken()` from the NextAuth session — **the only token source**; the `localStorage` / `demo-guest-token` path is gone from `api.ts`, `messagingApi.ts`, `useSocket.ts`), `lib/authApi.ts`, new pages `/auth/verify-email`, `/auth/forgot-password`, `/auth/reset-password`, reworked `/auth/signin`.

### Workspace authorization
* `services/workspaceAccess.js` — single source for roles (`member < admin < owner`), the permission table and `getMembership`. `requireWorkspaceMember` / `requireRole` use it; non-UUID ids are `400`, non-members `403`.
* **Sockets**: connection requires a live session. `workspace:join_request` verifies membership in the DB (previously it *inserted* the caller into `workspace_members` and fabricated a user row, and gave everyone `owner`). One workspace per socket. Every `chat:message` / `presence:typing` re-checks membership and role; removed members are evicted from the room immediately; logout/reset disconnects the user's sockets; sockets close when the token expires.
* **Cross-workspace holes fixed**: studio proxy let a client override `workspace_id` in the body; agent `approve`/`status` accepted any run id; `summarize` accepted any source id; chat `conversation_history` was forwarded unfiltered (forged `system` turns now dropped).
* Member management: last-owner protection under a workspace row lock; only **verified** users can be added; emails normalised.
* SSRF: `POST …/sources/url` rejects non-http(s), credentials in URL, `localhost`/`.internal`/`.local`, and any host that resolves to a private/loopback/link-local/metadata address.

### AI service
* New `ai/security.py`: every route except `/health` requires `Authorization: Bearer <AI_SERVICE_TOKEN>` (constant-time compare). Missing/weak token → service refuses to start; if it is somehow absent at request time → `503` (fail closed). `/docs` and `/openapi.json` are off unless `AI_ENABLE_DOCS=true`.
* Backend → AI goes through `backend/src/services/aiClient.js` only (`post`, `get`, `postStream`); it attaches the token. **Other agents: use `aiClient`, never raw axios to `AI_SERVICE_URL`.** AI error bodies are not relayed (only 429/503/504 safe `detail` strings).
* `docker-compose.yml`: no default secrets (`JWT_SECRET`, `AI_SERVICE_TOKEN`, `NEXTAUTH_SECRET`, `REDIS_PASSWORD` are required), Redis has a password and is bound to `127.0.0.1`, AI host port is `127.0.0.1` only.

## 2. Migration — `20261002010000_auth_security_consistency.sql`
Additive, idempotent, preserves data. Adds `users.password_hash/email_verified_at/updated_at`, `auth_sessions`, `auth_tokens` (RLS on, no policies), lower-case-email unique index (skipped with a NOTICE if case-duplicates exist), role CHECKs (`workspace_members`: member/admin/owner; `chat_messages`: user/assistant), `NOT NULL workspace_id` on `sources/source_chunks/chat_messages/agent_runs` (skipped with a NOTICE if NULL rows exist), `UNIQUE (id, workspace_id)` on `sources` + composite FK `source_chunks(source_id, workspace_id)`, `source_chunks.location_label`, and workspace-scoped indexes. `sources.status` is intentionally **not** constrained.

**Existing accounts** (created by the old passwordless flow) keep all data but have no password and no verified email, so they cannot sign in until the mailbox owner uses *Forgot password* (which also verifies the address). Nothing is auto-verified. This includes the seeded demo user.

## 3. Environment (see `backend/.env.example`, `ai/.env.example`)
Backend: `JWT_SECRET`, `AI_SERVICE_TOKEN`, `REDIS_PASSWORD`/`REDIS_URL`, `CORS_ORIGINS`, `APP_URL`, `SMTP_URL`+`MAIL_FROM` (required in production; without it outside production verification/reset links are printed to the backend console), `RATE_LIMIT_STORE`, `TRUST_PROXY`. AI: `AI_SERVICE_TOKEN` (same value), `AI_ENABLE_DOCS`. Frontend: `NEXTAUTH_SECRET`, optional `API_INTERNAL_URL`. Generate secrets with `openssl rand -hex 32`.

**Action required before the next start:** existing `backend/.env`, `ai/.env` and the compose `.env` must define these (the services now refuse to start otherwise); any existing `JWT_SECRET` that is a placeholder must be replaced. Existing sessions/tokens are invalid after the upgrade (users sign in again).

## 4. Tests and commands
```bash
# throwaway infra (does not touch the dev DB/Redis)
docker run -d --name cm-p1-pg -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=clean -p 127.0.0.1:55432:5432 ankane/pgvector:latest
docker run -d --name cm-p1-redis -p 127.0.0.1:56379:6379 redis:7-alpine redis-server --requirepass testredispw
# clean-DB migration (storage schema stubbed: the messaging migration needs Supabase's storage.buckets)
docker exec cm-p1-pg psql -U postgres -d clean -v ON_ERROR_STOP=1 -c "create schema storage; create table storage.buckets(id text primary key, name text, public bool, file_size_limit bigint);"
for f in 20260807000000_initial_schema 20261002000000_messaging_and_calls 20261002010000_auth_security_consistency; do
  docker cp supabase/migrations/$f.sql cm-p1-pg:/tmp/$f.sql && docker exec cm-p1-pg psql -U postgres -d clean -v ON_ERROR_STOP=1 -q -f /tmp/$f.sql; done

# backend
cd backend && npm test                                   # unit + (skipped without env)
TEST_DATABASE_URL=postgresql://postgres:testpw@127.0.0.1:55432/clean \
TEST_REDIS_URL=redis://:testredispw@127.0.0.1:56379 npm test   # + integration (real DB, Redis, sockets)

# ai (needs the service dependencies; the image has them)
docker run --rm -v "$PWD/ai:/app:ro" -w /app colabmind-ai sh -c "pip install -q pytest httpx && python -m pytest tests/test_service_auth.py -q -p no:cacheprovider"
```
