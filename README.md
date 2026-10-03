# CollabMind AI

Collaborative study workspaces: upload documents, ask grounded questions with citations, generate
flashcards/quizzes/guides/reports, run a study-coach agent, and message or call teammates.

| Service | Path | Stack |
|---|---|---|
| Frontend | `frontend/` | Next.js 16, NextAuth (email + password), Zustand |
| Backend | `backend/` | Node 22, Express, Socket.IO, Postgres, Redis, LiveKit |
| AI service | `ai/` | FastAPI, pgvector, BGE-M3 embeddings, DeepSeek models, LangGraph |
| Database | `supabase/migrations/` | Postgres + pgvector (apply with the Supabase CLI) |

## Run with Docker Compose

1. Copy `.env.example` to `.env` and fill in the required secrets (`JWT_SECRET`, `AI_SERVICE_TOKEN`,
   `NEXTAUTH_SECRET`, `REDIS_PASSWORD`, `DATABASE_URL`, plus the model keys). Secrets must be random and
   at least 32 characters; the services refuse to start otherwise.
2. Apply the migrations in `supabase/migrations/` to your database (the Phase 3 migration re-creates the
   embedding column and deletes old chunks: take a backup first, then run `python -m scripts.reindex`).
3. `docker compose up --build` (add `--profile embeddings` to self-host BGE-M3).

Frontend: http://localhost:3000 · Backend: http://localhost:4000 (`/health`, `/ready`) · AI: loopback only.

## Tests

```bash
cd backend && npm test                  # unit tests; set TEST_DATABASE_URL and TEST_REDIS_URL for integration tests
cd frontend && npm test
cd ai && pip install -r requirements.txt -r requirements-dev.txt && pytest
```

## Account and workspace model

- Workspace owners **invite** people by email; the invitee accepts or declines from the dashboard
  (`/api/invites`). Nothing reveals whether an address is registered. Members see each other's names;
  email addresses are shown to owners and admins only.
- `/settings`: change password, sign out of all devices, delete account (blocked while you own a workspace
  that still has other members).
- Document parsing runs in a sandboxed child process (see `ai/.env.example`, `EXTRACTION_*`).
- CI (`.github/workflows/ci.yml`) runs every suite against Postgres+pgvector and Redis.

## Deploying

`render.yaml` describes the three services. `docs/phase4-deployment-checklist.md` lists the
pre-launch steps, and `docs/full-audit-2026-10-03.md` the open security and reliability items.
Behind a reverse proxy set `TRUST_PROXY` so rate limits see real client IPs.
