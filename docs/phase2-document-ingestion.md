# Phase 2 — Document ingestion & processing

Branch: `phase2-document-ingestion` (uncommitted working tree; nothing pushed).

## What already existed (audited, reused)
Upload route + workspace-membership check, MarkItDown extraction with per-page/slide/sheet locations, token chunker,
`source_chunks` storage with `page_number`/`location_label`, SSRF-guarded URL fetch, local/GCS storage, status polling UI.

## What this phase changed
| Area | Change |
|---|---|
| Upload validation | `backend/src/services/fileValidation.js`: non-empty, magic-byte check per format (PDF/Office/XLS), binary-in-text rejection, filename sanitising (no path parts/control chars, ≤200 chars), SHA-256. Multer errors map to 413/400. |
| Duplicates | Same SHA-256 in the same workspace → `409` with the existing `source_id`. Same file in another workspace is allowed. |
| Storage | UUID-validated ids; local writes checked to stay inside `UPLOADS_DIR`; `deleteStoredFile` (GCS + local, contained); orphan file removed if the DB insert fails. |
| Authorization | All source routes: `authenticate` → UUID params → `requireWorkspaceMember`; every query is `workspace_id`-scoped (a source id from another workspace is a 404). Delete = creator or workspace admin/owner. |
| Lifecycle | `processing` → `ready` \| `failed`. Progress in `sources.metadata.stage` (`queued, extracting, chunking, embedding, storing`). `ready` is written in the same transaction as the chunks. AI service unreachable/auth-rejected → marked `failed` (no more stuck `processing`). |
| Retry | `POST …/retry` atomically claims a `failed` source (or one `processing` > `SOURCE_STALE_MINUTES`, default 10); concurrent clicks start one job (409 otherwise). |
| Idempotency | Embedder locks the source row (`FOR UPDATE`), deletes old chunks and inserts new ones in one transaction; a failed run deletes nothing. A source deleted mid-run is not resurrected. |
| AI-service trust | `/embed` verifies `(source_id, workspace_id, storage_url)` against the `sources` row before reading any file. |
| Chunking | Env-configurable `CHUNK_SIZE_TOKENS` (512) / `CHUNK_OVERLAP_TOKENS` (50), validated; fixed U+FFFD at multi-byte token boundaries. |
| Errors | Password-protected PDFs get a specific message. |
| Frontend | Client-side type/size/empty checks, multi-file upload, specific error text, stage label on the badge, Retry (failed) and Delete buttons. |

No new tables or columns from this phase (progress/metadata live in `sources.metadata` JSONB), so nothing to coordinate in migrations.
Metadata keys written: `sha256, size_bytes, stage, attempts, error, chunk_count, char_count, page_count, embedding_model, embedding_dim, processed_at`.

## Supported formats
PDF (text layer), DOCX, PPTX, XLSX, XLS, TXT, MD, CSV, HTML/HTM, JSON; plus http(s) web pages.
Locations: PDF → real `page_number` + "Page N"; PPTX → "Slide N"; XLSX → "Sheet: name"; DOCX/HTML/MD → "Section: heading"; TXT/CSV/JSON → none (never invented).
Limits: 50 MB upload (AI service reads ≤ 60 MB), 180 s extraction timeout, URLs ≤ 10 MB.

## Documented limitations
- **No OCR**: scanned/image-only PDFs fail with "No readable text… OCR is not supported yet".
- Encrypted PDFs are rejected, not unlocked. Legacy `.doc/.ppt`, images, audio, YouTube links are unsupported.
- DOCX has no page numbers (the format has none without rendering); sections are used instead.
- Chunk token counts use `cl100k_base` as a proxy for BGE-M3's tokenizer (512 is far inside BGE-M3's 8192 context).
- Duplicate detection is exact-content only (renamed identical file is caught; re-saved/edited file is not).
- URL sources have no content-hash dedupe.

## API contract (all under `/api/workspaces/:workspaceId/sources`, Bearer auth, member required)
| Method & path | Result |
|---|---|
| `GET /` | `Source[]` newest first (`?type=`) |
| `GET /:sourceId` | `Source` (status, `metadata.stage`, `metadata.error`) / 404 |
| `POST /upload` (multipart `file`) | `202 {source_id,status}`; `400` invalid/empty/unsupported; `409` duplicate (+`source_id`); `413` too large |
| `POST /url` `{url}` | `202 {source_id,status}` |
| `POST /:sourceId/retry` | `202`; `409` if ready/in progress; `404` |
| `DELETE /:sourceId` | `204`; `403` not creator/admin; `404`. Cascades chunks, removes stored file |
| `POST /:sourceId/summarize` | unchanged |

AI service: `POST /embed {workspace_id, source_id, storage_url}` (idempotent; always ends in `ready` or `failed`). Redis `ai_updates` events: `source:progress|ready|failed`.

## Tests (actual results, this machine)
- AI: `pytest` → **145 passed** (my additions: `test_chunker.py` 11, `test_embedder_lifecycle.py` 7, `test_extractor_errors.py` 6, plus fixture updates in `test_embedder.py`; the rest are other phases' and the earlier extractor/embedder tests). Windows venv with Python 3.14 outside the repo.
- Backend: `npm test` → **32 passed** (24 in `test/sources.test.js`: real Express router + real multer + real local storage against an in-memory pool stub; auth is stubbed with a header because Phase 1 owns it).
- Frontend: `tsc --noEmit` shows only one pre-existing error in generated `.next/dev/types/validator.ts`; nothing from changed files.

Covered: valid PDF/TXT, empty, unsupported extension, wrong-signature PDF/DOCX, binary-as-text, oversize (413), path-traversal filename, duplicate (same/different workspace), DB failure cleanup, 401/403/404 on every route, cross-workspace id isolation, malformed UUIDs, creator/admin/owner delete, retry states, AI-unreachable → failed, real PDF page numbers, blank-page numbering, scanned PDF, encrypted PDF, corrupt PDF, retry/replace-chunks, partial embedding failure stores nothing, source-deleted-mid-run, URL/redirect SSRF.

## Integration notes
**Phase 1:** I use only `authenticate`, `requireWorkspaceMember`, `requireUuidParams` and `services/aiClient` (via `sourceService.triggerAiEmbedding`). A 401/403/503 from the AI service marks the source failed. No new statuses or tables. Metadata keys above are in JSONB; your composite FK `source_chunks(source_id, workspace_id)` is satisfied by the insert.
**Phase 3:** chunk contract is unchanged: `(workspace_id, source_id, chunk_index, content, page_number, location_label)` + your `embedding_model/dim`; `chunk_index` is 0-based and contiguous per source; chunks never cross a page/slide/sheet. Embedder calls `_embed_texts` and `get_embedding_client().check_configured()`. Retrieval should only trust chunks of sources with `status='ready'` (a re-run replaces chunks in one transaction, so there is no window with partial chunks for a ready source; during a *retry* of a previously-ready source the old chunks stay until the new ones commit).
**Phase 4:** processing is a fire-and-forget HTTP call from the backend; durability = the DB row. Needed for a real queue: a worker that picks `status='processing'` rows with `metadata.stage='queued'` (or stale `updated_at`), calling the same idempotent `/embed`; `beginRetry` is the atomic claim to reuse; `attempts` is already counted but there is no max-attempts/backoff.

## Remaining risks / unverified
- **Not run against a real Postgres/pgvector**: the SQL (`FOR UPDATE`, `jsonb` merge, `make_interval`, `metadata->>'sha256'`) is verified only against recording fakes. The retriever/schema compatibility (1024-d columns) is a static read; Phase 3's migration was not applied or executed.
- No end-to-end run through Docker/GCS; GCS upload/delete paths are untested.
- Real BGE-M3 embedding was not exercised (tests stub `_embed_texts`).
- No `sha256` index: dedupe lookup scans a workspace's sources (fine at small scale).
- Duplicate check and insert are not atomic: two simultaneous identical uploads can both pass (needs a unique index on `(workspace_id, metadata->>'sha256')`, a schema change to coordinate).
- Stage updates are best-effort writes; the UI still polls every 4 s rather than using the socket events.
- Large files are read fully into memory (50 MB cap).
- Frontend not exercised in a browser.
