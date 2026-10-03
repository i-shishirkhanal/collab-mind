# Phase 3 — Multi-model integration and grounded RAG

Status of every claim below is marked **[verified]** (run against the real thing and observed),
**[mock-tested]** (covered by deterministic tests with the provider mocked at the HTTP layer) or
**[not verified]** (not run; see *Limitations*).

## 1. Model routing

| Work | Task | Model (default env value) | Notes |
|---|---|---|---|
| Ordinary chat, follow-ups, summaries, flashcards, quizzes, study guides, study-coach plan/topics/materials | `chat` / `study` | **DeepSeek V4.1 Flash** — `deepseek-flash` | thinking disabled by default (latency) |
| Complex research / reasoning, long-form reports | `research` | **DeepSeek V4 Pro** — `deepseek-v4-pro` | thinking enabled by default |
| Document + query embeddings | — | **BGE-M3** — `BAAI/bge-m3`, 1024-d dense | no fallback of any kind |

Gemini is gone from code, config, compose and requirements.

**Provider facts** (from DeepSeek's API docs, fetched 2026-10-02): base URL `https://api.deepseek.com`, `POST /chat/completions`
(OpenAI format); model ids `deepseek-flash` (= V4.1 Flash) and `deepseek-v4-pro` (= V4-Pro-0813); legacy `deepseek-v4-flash`
still accepted and served by V4.1 Flash; thinking via `"thinking": {"type": "enabled"|"disabled"}` (temperature is ignored in
thinking mode; reasoning arrives in a separate `reasoning_content` field which we never forward); JSON mode via
`response_format: {"type":"json_object"}`; errors 400/401/402/422/429/500/503; streaming with `stream_options.include_usage`.
A third-party article claimed `deepseek-v4-pro` was temporarily served by V4.1 Flash; the official pages say otherwise.
Because this can change, **every response reports `route.model_used` exactly as the provider returned it**, and
`route.model_requested` next to it — compare them if you need to know.

**Routing logic** (`ai/llm/router.py`): explicit `task` in the request wins; otherwise a conservative regex classifier
(compare/contrast, critique/evaluate, synthesize, trade-offs, literature-review/methodology …) escalates to `research`
when `LLM_AUTO_ROUTE_RESEARCH=true`; everything else is `chat`. Research also retrieves 2× `RETRIEVAL_TOP_K` passages.

**Reliability**: transient errors (429, 500/502/503/504, timeouts, connection errors) are retried `LLM_MAX_RETRIES` times with
exponential backoff, honouring `Retry-After`. 401/402/400/422/malformed responses are never retried. Optional
`LLM_FALLBACK_PRO_TO_FLASH` (default **off**) serves a failed Pro request with Flash and says so
(`route.fallback_used`, `route.fallback_reason`, `route.model_used`). Streaming retries/falls back only before the first token.
API keys live only in the AI service environment; log lines and error messages pass through a redaction filter.

## 2. BGE-M3 embeddings

`ai/rag/embedding_provider.py` calls any OpenAI-compatible `/embeddings` endpoint serving `BAAI/bge-m3`. Documents and queries use
the same model, endpoint and (absent) instruction prefix. Every response is checked: vector count, dimension == `EMBEDDING_DIM`
(1024), finite values, non-zero; vectors whose norm is not 1 are L2-normalised. Any failure raises `EmbeddingUnavailableError`
→ HTTP 503 for queries, `failed` source with a safe reason for indexing. The hash/“dev” fake-vector paths were deleted.

Storage: `source_chunks.embedding vector(1024)` plus `embedding_model`, `embedding_dim`; HNSW cosine index. At startup the
service compares the column's dimension with `EMBEDDING_DIM`; on mismatch indexing and retrieval refuse with a message telling
you to apply the migration (it never alters the column itself).

### Deployment options
1. **Self-hosted, CPU or GPU — HuggingFace Text-Embeddings-Inference** (compose profile `embeddings`):
   `docker compose --profile embeddings up -d embeddings`, then `EMBEDDING_BASE_URL=http://embeddings:80/v1`.
   Use a `cuda-*` TEI image + GPU reservation for GPU. Model weights are downloaded on first start (see measured sizes in §8).
2. **Hosted OpenAI-compatible API** serving `BAAI/bge-m3`, e.g. SiliconFlow (`https://api.siliconflow.com/v1`, per its docs
   `BAAI/bge-m3` accepts up to 8192 tokens, max 32 inputs per request). Set `EMBEDDING_API_KEY`. **[not verified]** (no key available).
3. vLLM or any other server exposing `/v1/embeddings` for bge-m3 works with the same settings.

Only BGE-M3's *dense* output is used. Its sparse/multi-vector outputs are not; keyword matching comes from PostgreSQL full-text
search instead.

## 3. Retrieval (workspace-scoped, hybrid)

`ai/rag/retriever.py`, one SQL per signal, always `WHERE sc.workspace_id = $1 AND s.status = 'ready'` with bound parameters:
1. vector: `1 - (embedding <=> query)` cosine similarity, `RETRIEVAL_CANDIDATES` nearest;
2. keyword: `websearch_to_tsquery('simple', …)` against the generated `fts` column (GIN-indexed);
3. Reciprocal-rank fusion (`RETRIEVAL_RRF_K`), then the relevance gate: keep a chunk only if similarity ≥
   `RETRIEVAL_MIN_SIMILARITY` (0.35), or it also matched the keyword query and similarity ≥ `RETRIEVAL_FTS_RESCUE_MIN_SIMILARITY` (0.25);
4. top `RETRIEVAL_TOP_K`.

Filters: `source_ids` (document-level constraint) and `source_types`. If nothing passes the gate the pipeline answers
“I could not find an answer in your workspace sources.” with `grounding: "no_sources"` and **does not call a model**.
**The default thresholds are starting points** — BGE-M3 cosine scores depend on your corpus; calibrate (see §8 for the scores observed).

Authorization: the AI service trusts `workspace_id` from the backend, which derives it from the authenticated user's verified
membership (`requireWorkspaceMember`); the service itself is only reachable with `AI_SERVICE_TOKEN` (Phase 1).

## 4. Grounded answers and citations

The model sees numbered passages (`[1] Source: biology.pdf | Page 3`) in the *user* turn, flagged as data, with rules in the system
prompt: cite `[n]` after each supported sentence, refuse with the exact sentence if unsupported, put anything beyond the sources in
a final paragraph starting “Beyond your sources:”. Afterwards `rag/grounding.py`:
- strips any `[n]` that does not refer to a retrieved passage (and adds a warning);
- builds each citation **from the retrieved chunk** (source id/name, page, location label, chunk index, similarity, 280-char excerpt) —
  nothing a model writes about pages or quotes is trusted;
- sets `grounding`: `grounded` (≥1 valid citation), `uncited` (answer has none → warning, no citations), `no_answer` (model refused),
  `no_sources` (retrieval found nothing).

A page number is only present if the extractor produced one (PDF pages); slides/sheets/sections use `location_label`.
This guarantees citations *resolve* to real chunks; it cannot guarantee the model's sentence is actually supported by the chunk it cites.

## 5. API contracts

### AI service (all routes except `/health` need `Authorization: Bearer $AI_SERVICE_TOKEN`)
`POST /chat`
```jsonc
// request (old minimal form still works)
{ "workspace_id": "…", "message": "…", "conversation_history": [{"role":"user|assistant","content":"…"}],
  "user_id": "…",            // optional, usage accounting
  "source_ids": ["…"],       // optional document constraint
  "task": "chat|study|research" }   // optional, forces routing
// response
{ "answer": "… [1]", "grounding": "grounded|uncited|no_answer|no_sources", "warnings": ["…"], "task": "chat",
  "citations": [{ "index": 1, "source_id": "…", "source_name": "biology.pdf", "page_number": 3, "chunk_index": 0,
                  "location_label": "Page 3", "excerpt": "…", "similarity": 0.81 }],
  "route": { "provider":"deepseek","tier":"flash","model_requested":"deepseek-flash","model_used":"deepseek-flash",
             "attempts":1,"fallback_used":false,"fallback_reason":null,"latency_ms":1234 },   // null when no model was called
  "usage": { "prompt_tokens":…, "completion_tokens":…, "total_tokens":…, "reasoning_tokens":… } }  // null/fields null if not reported
```
`POST /chat/stream` — same request; `text/event-stream` with `event: delta` `{text}` …, then `event: result` (the full `/chat`
response, authoritative) or `event: error` `{code,message}`. Failures before the first byte are normal HTTP errors.
`GET /models` — active routing/retrieval config, no secrets. `POST /embed`, `/sources/summarize`, `/studio/*`, `/agents/*` keep their contracts.

Errors (`{"detail": "<safe message>", "code": "…"}`): `not_configured` 503, `embedding_unavailable` 503, `model_unavailable` 503,
`provider_overloaded` 503, `provider_rate_limited` 429 (+`Retry-After`), `provider_timeout` 504, `malformed_response` 502,
`provider_auth_failed` / `provider_insufficient_balance` / `provider_invalid_request` 502, `no_relevant_sources` 404 (studio tools).
Studio tools no longer return “extractive” filler or canned “upload a document” cards when the model/sources are missing.

### Backend
`POST /workspaces/:id/chat` body adds optional `source_ids` (UUID array) and `task`; the assistant message `metadata` now holds
`citations` (as before) plus `grounding`, `warnings`, `task`, `model` (route) and `usage`. History comes from the stored
workspace conversation (last 10 turns) when the client sends none. 429/503/504 from the AI service keep their status and safe message;
everything else is a generic 502. Socket.io `chat:message` now streams `chat:delta {requestId,text}` previews before the final persisted
`chat:message` (clients that ignore `chat:delta` keep working; **the frontend does not render the stream yet**).

## 6. Configuration
See `ai/.env.example` (all variables, validated at startup by `ai/config.py`: bad values stop the service; missing keys are logged and
the affected endpoints return 503). Nothing here is exposed to the frontend bundle. Migration for existing databases:
`supabase/migrations/20261002020000_phase3_embeddings_rag.sql` — **destructive for chunks** (old 768-d Gemini/hash vectors cannot be converted):
it deletes `source_chunks`, flags those sources `failed` + `needs_reindex`, resizes the column; then run `cd ai && python -m scripts.reindex`.
`ensure_schema()` in `ai/db.py` is a read-only check: it verifies the migrations were applied and that the vector column matches the configured dimension (it never runs DDL). A mismatch makes indexing and retrieval fail loudly.

## 7. Tests
```bash
cd ai
pip install -r requirements-dev.txt
pytest -q                                   # mocked-provider suite; DB/real-model tests skip unless env vars are set
TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55873/cm pytest tests/test_retrieval_db.py     # real pgvector SQL
BGE_M3_URL=http://127.0.0.1:55874/v1 TEST_DATABASE_URL=… pytest tests/test_bge_m3_real.py -s        # real BGE-M3
cd ../backend && node --test test/chatService.ai.test.js
```
Results are recorded in §8.

## 8. Results, limitations, risks

### Test results (2026-10-02, Windows, Python 3.14 venv, pgvector 0.5.1 in Docker, TEI 1.9.4 CPU)
| Command | Outcome |
|---|---|
| `pytest -q` (no env vars) in `ai/` | **217 passed, 11 skipped** (skips = real-DB / real-model tests). Includes Phase 2's tests. |
| same with `TEST_DATABASE_URL` → disposable `ankane/pgvector` container | **226 passed** earlier in the session (adds 9 real-SQL tests: workspace isolation, `ready`-only, thresholds, document filter, keyword rescue, SQL-injection text, schema guard, `sample_chunks`, `llm_usage` + chunk INSERT). A later re-run failed only those 9 because Docker had stopped (connection refused) — environment, not code. |
| `BGE_M3_URL=… TEST_DATABASE_URL=… pytest tests/test_bge_m3_real.py -s` | **2 passed, 497 s — REAL BAAI/bge-m3** (HF TEI 1.9.4, CPU, fp32 ONNX): 1024-d unit vectors; query “How do plants turn sunlight into energy?” scored photosynthesis 0.664, Spanish photosynthesis 0.656, mitochondria 0.426, tax text 0.233; stored in pgvector and retrieved end to end with workspace isolation; unrelated query returned nothing. |
| `node --test test/chatService.ai.test.js` in `backend/` | **8 passed** |
| Migration `20261002020000` on a baseline-schema DB with a 768-d row | applied; column → 1024, old chunk deleted, source flagged `needs_reindex`; second run is a no-op. Also caught that the baseline lacks `location_label` (now added). |

Mocked (deterministic) coverage: routing to Flash/Pro and request shape (model id, thinking, JSON mode), retry/`Retry-After`/bounded
attempts, 401/402/404/422/429/5xx/timeout/connection/malformed mapping, missing key makes no request, fallback off by default and
reported when on, provider-reported model recorded, usage capture, secret redaction, streaming (+retry before first byte), BGE-M3 client
(order, batching, normalisation, dimension/count/zero-vector rejection, retries, no-fake-vector), retrieval fusion/thresholds, workspace-bound SQL
parameters, citation resolution (invalid `[n]` stripped, metadata copied from chunks, uncited/refusal/no_sources), prompt-injection placement,
history handling, studio JSON validation and source_ref grounding, HTTP error contract, SSE contract, backend history/metadata/error/stream handling.

### NOT verified — do not assume these work
- **No real DeepSeek request was made** (no `DEEPSEEK_API_KEY` in this environment). Model ids, the `thinking` parameter, `stream_options`, JSON mode and
  usage field names follow DeepSeek's published docs but are only exercised against mocks. First action in staging: `POST /chat` once with
  `task:"chat"` and once with `task:"research"` and check `route.model_used`, `usage`, and that `thinking:{"type":"disabled"}` is accepted.
- Hosted BGE-M3 (SiliconFlow etc.) not tried; only self-hosted TEI was.
- Full Docker Compose stack, the frontend (it does not render `chat:delta` or the new citation fields), and the studio endpoints against a real model.
- The ReAct `StudyCoachAgent` (LangChain tools) is never invoked by the app and was only constructed, not run; the LangGraph study-coach flow is what runs and is mock-tested.
- Answer *faithfulness* with a real model (does the cited chunk really support the sentence). Citations are guaranteed to resolve, not to be correct.

### Performance and resources (measured where stated)
- TEI CPU on this 4 GB-RAM Docker host: first start downloaded the ~2.2 GB ONNX weights (~12.6 min on this link); with default settings the container was
  **OOM-killed during warm-up**; with `--max-batch-tokens 1024 --max-client-batch-size 16` it ran at **~2.45 GiB resident**. A cold single short input took ~11 s;
  the 8-text real test took ~8 min total on this contended machine. **CPU embedding is slow here — expect indexing a large document to take minutes; use a GPU
  or a hosted endpoint for real workloads.** Not a benchmark (shared host, cold caches).
- `max-batch-tokens` also caps input length with `auto_truncate` on: with 1024, inputs over 1024 tokens are silently truncated. Default chunks are 512 tokens, so fine — keep
  `--max-batch-tokens` ≥ `CHUNK_SIZE_TOKENS`. The compose `embeddings` service uses TEI defaults; on hosts with < ~6 GB RAM add `--max-batch-tokens 1024`.
- Pro with thinking enabled is slow and bills reasoning tokens; the backend allows 150 s for a chat turn. Flash chat has thinking disabled for latency.
- Each chat does 1 query embedding + 2 SQL queries + 1 model call; the HNSW index applies to the vector query, but with a restrictive `workspace_id`/`source_ids` filter
  pgvector's post-filtering can return fewer than `RETRIEVAL_CANDIDATES` rows (pgvector ≥ 0.8 `hnsw.iterative_scan` fixes this; not enabled).

### Remaining risks
1. **Branch isolation failed**: all sessions share one working tree; Phase 1 switched it to `phase1/auth-security` after I created `phase3/ai-models-rag`. Phase 3 changes are **uncommitted in the shared tree** and mixed with other phases' uncommitted work.
2. Migration is destructive for existing chunks and requires re-indexing (needs the embedding service up). Until it is applied, the service starts but refuses indexing/retrieval (schema guard).
3. Similarity thresholds (0.35 / 0.25) were checked on 4 toy passages only — calibrate on real documents. Scores near the floor (e.g. mitochondria 0.43 vs a photosynthesis query) will pass.
4. `StudyCoachAgent` tools take `workspace_id` as an LLM-chosen argument — a prompt-injection path across workspaces if that agent is ever wired up. Pass it from trusted state instead before enabling it.
5. The AI service trusts `workspace_id`/`source_ids` from the backend (Phase 1 token protects the channel). `source_ids` from another workspace simply match nothing (tested).
6. Chat history is the shared workspace conversation (other members' messages included in context); a client-supplied history, if sent, is used instead.
7. `llm_usage` has no retention/aggregation endpoint yet; usage recording is best-effort.
8. `ai/.env` still contains a `GEMINI_API_KEY` line (unused now) — remove it; consider rotating that key.
9. A third-party article's claim vs. DeepSeek docs about `deepseek-v4-pro` aliasing is unresolved without a live call (see §1).
