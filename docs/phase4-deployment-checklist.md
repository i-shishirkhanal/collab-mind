# Deployment checklist (staging first)

Everything here was derived from what Phase 4 actually ran. Items marked **(not run)** were not executed against a real target.
Never run a step against production data without a verified backup and the owner's explicit approval.

## 0. Prerequisites and sizing
| Need | Detail |
|---|---|
| PostgreSQL ≥ 15 with `pgvector` ≥ 0.5 (HNSW). Tested: pgvector 0.5.1 (`ankane/pgvector`) and the Supabase project's PG 17. | The migration chain needs Supabase's `storage.buckets` table (messaging migration); on plain Postgres create a stub first (see the test report). |
| Redis 7 with a password | sessions' rate limits, socket adapter, pub/sub. |
| BGE-M3 endpoint | Self-hosted TEI (CPU image tested: **~2.3 GB weights, ~2.45 GiB RAM with `--max-batch-tokens 1024`; default warm-up was OOM-killed on a 4 GB host**; first download took ~12 min) or any OpenAI-compatible `/embeddings` server. CPU indexing is slow (a 3-page PDF took ~30 s when idle; the 8-text real test took minutes when the host was busy). Use a GPU or hosted endpoint for real load. Keep `--max-batch-tokens` ≥ `CHUNK_SIZE_TOKENS` (512), otherwise longer inputs are silently truncated. |
| Chat models | An API key for the chosen endpoint. Decide the endpoint and the two model ids first (audit P4-032): required = DeepSeek V4.1 Flash for chat/study, DeepSeek V4 Pro for research. |
| Host memory | api+ai+backend+frontend+redis ≈ 0.4 GiB idle in the test; plus TEI ≈ 2.5 GiB. |

## 1. Secrets and environment (nothing in git)
1. Copy `.env.example` → `.env`; generate each secret with `openssl rand -hex 32`: `JWT_SECRET`, `AI_SERVICE_TOKEN`, `NEXTAUTH_SECRET`, `REDIS_PASSWORD`.
2. Set `DATABASE_URL`, `CORS_ORIGINS`, `APP_URL`, `NEXTAUTH_URL` to the **public https** origins, `SMTP_URL`/`MAIL_FROM` (required when `NODE_ENV=production`).
3. Set `DEEPSEEK_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_FLASH`, `LLM_MODEL_PRO`; `EMBEDDING_BASE_URL` (+ `EMBEDDING_API_KEY`).
4. Optional features: `GCS_BUCKET_NAME` (+ credentials mounted into backend **and** AI containers), `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, `LIVEKIT_*`.
5. The local `.env` files that predate Phase 1 lack the new required variables; services refuse to start until they are added. They also still contain a now-unused `GEMINI_API_KEY` — delete the line and **consider rotating that key** (it was in plain `.env`). Rotation is the owner's action.
6. `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` are baked into the browser bundle at image build time; rebuild the frontend image after changing them.

## 2. Database migration (destructive for chunks — read first)
Applies in filename order: `20260807000000_initial_schema`, `20261002000000_messaging_and_calls`, `20261002010000_auth_security_consistency`, `20261002020000_phase3_embeddings_rag`, `20261003000000_phase4_integration_fixes`, `20261003010000_status_checks`, `20261003020000_workspace_invites`.
* The last two are additive (status CHECKs on `sources`/`agent_runs`, normalising legacy `error` to `failed`; the `workspace_invites` table). **Apply them before deploying this version**: the backend's invite endpoints need the table, and the AI service no longer creates schema objects at boot (it only checks them).
* All are idempotent; the Phase 3 one **deletes every row of `source_chunks`** (old 768-d vectors cannot be converted), flags the affected `ready` sources `failed` + `needs_reindex`, and resizes the column to `vector(1024)`. Source rows and files are kept.
* Phase 1's migration normalises e-mail case and role values; existing accounts have no password and must use "Forgot password" once.
* Phase 4's enables RLS on the core tables (no policies; the backend/AI connect as the table owner and are unaffected). **If your DB role is not the table owner and does not have BYPASSRLS, the application will see zero rows** — check `select rolbypassrls from pg_roles where rolname = current_user` (Supabase `postgres` has it).
Procedure:
1. Take a backup (`pg_dump -Fc` or a Supabase backup) and record its location. **(not run)**
2. `select count(*) from sources, source_chunks` to see what the Phase 3 step will delete.
3. Apply the five files in order with `psql -v ON_ERROR_STOP=1 -f …`. **(not run against the Supabase project; run on a disposable pgvector container and on a baseline-schema DB with a 768-d row — both OK)**
4. Verify: `select atttypmod from pg_attribute where attrelid='source_chunks'::regclass and attname='embedding'` → `1024`; `select relname, relrowsecurity from pg_class where relname in ('users','workspaces','sources','source_chunks','chat_messages','agent_runs','workspace_members','llm_usage')` → all `t`; run the Supabase security advisor.
Rollback: restore the backup. (The Phase 3 step is not reversible by SQL.)
State of the only Supabase project found (`colab mind`, read-only check): only `initial_schema` applied, `vector(768)`, RLS already enabled, **0 rows** in every app table → applying the chain there deletes nothing, but it still needs the owner's go-ahead.

## 3. Reindex (after step 2, once the embedding endpoint answers)
```bash
cd ai && python -m scripts.reindex          # sources flagged needs_reindex
python -m scripts.reindex --all             # everything (e.g. after changing the embedding model)
```
Uses the normal `/embed` path, so it is idempotent (chunks are replaced in one transaction per source), resumable (rerun picks up what is still flagged) and workspace-safe (each source is processed with its own workspace id). Failures are written to `sources.metadata.error`. Sources whose file is gone end as `failed`; ask the owners to re-upload.

## 4. Bring-up
```bash
docker compose build
docker compose --profile embeddings up -d        # include `embeddings` only if you self-host BGE-M3 here
docker compose ps                                # redis, ai, backend, frontend must be healthy (ai before backend)
```
Existing deployments: the images now run as uid 1000. A pre-existing root-owned `uploads_data` volume must be fixed once:
`docker run --rm -v <project>_uploads_data:/u alpine chown -R 1000:1000 /u`. **(not run)**
Health checks: `GET :4000/health`, `GET :8000/health` (the AI port is bound to 127.0.0.1), frontend `/auth/signin`. Behind a TLS proxy set `TRUST_PROXY=<hops>` and keep `NEXTAUTH_URL` as the public https URL.

## 5. Live-provider verification (the step that is still open for the required models)
With the key in the AI service environment, from `ai/`:
1. `curl -s -H "Authorization: Bearer $AI_SERVICE_TOKEN" localhost:8000/models` → confirm the two model ids and `llm_configured: true`.
2. Create a workspace, upload a small PDF, wait for `ready`.
3. `POST /api/workspaces/:id/chat {"message":"<question from the PDF>"}` → expect `201`, `metadata.grounding == "grounded"`, `metadata.model.model_used` = the **Flash** id, citations with the right page.
4. Same with `"task":"research"` → `metadata.model.tier == "pro"` and `model_used` = the **Pro** id. If `model_used` equals the Flash id, Pro is not actually in effect (audit P4-032 / the DeepSeek aliasing question).
5. Streaming: connect a socket, join, emit `chat:message`; expect `chat:delta` events then two `chat:message`.
6. Check `select model_used, total_tokens from llm_usage order by id desc limit 5`.
7. Only if the provider rejects `thinking` or `stream_options`: set `LLM_FLASH_THINKING=default` / `LLM_PRO_THINKING=default` (the field is then omitted).
Outcome of the one live probe that was run (third-party gateway, Flash model only) is in the audit, P4-032.

## 6. Smoke tests after every deployment
`node e2e/e2e.mjs` reproduces the 15-step acceptance run against throwaway containers (needs Docker, the TEI image + weights volume, a Python venv with `ai/requirements-dev.txt`; uses a mock LLM). For a real environment run steps 2-6 above and: register → verify → login (UI), upload PDF, ask, click a citation, delete the source, log out.

## 7. Recovery notes
| Situation | What happens / what to do |
|---|---|
| Embedding service down | chat → 503 (`embedding_unavailable`); uploads end `failed` (no chunks, no fake vectors); after recovery use **Retry** on the source (tested). |
| LLM down / rate limited | chat 502/503 / 429 with a safe message; nothing half-saved; no automatic model switch unless `LLM_FALLBACK_PRO_TO_FLASH=true`. |
| AI service restarted mid-index | source stays `processing`; after `SOURCE_STALE_MINUTES` (30) Retry is allowed. |
| Vector column ≠ `EMBEDDING_DIM` | AI service starts but indexing/retrieval refuse with a message naming the migration (it never alters the column itself). |
| Lost session secret (`JWT_SECRET` rotated) | all sessions invalid; users sign in again. |
