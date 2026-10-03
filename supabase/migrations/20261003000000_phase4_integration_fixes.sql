-- Phase 4: fixes found while integrating Phases 1-3. Additive and idempotent; nothing is deleted.

-- Row Level Security on the core tables. Hosted Supabase exposes the `public` schema through its HTTP API
-- to anyone holding the (public) anon key; without RLS every table below would be readable and writable
-- that way. The live "colab mind" project already has RLS enabled on these tables (observed via the
-- Supabase security advisor, 2026-10-03) but no earlier migration in this repository did, so a database
-- built from the migrations alone was exposed. No policies are created on purpose: all access goes
-- through the backend / AI service, which connect as the table owner (owners bypass RLS).
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces         ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources            ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_chunks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage          ENABLE ROW LEVEL SECURITY;

-- agent_runs.finished_at: written by ai/agents/study_coach_graph.py (save_results) and
-- ai/agents/runner.py (failure path) but never created by any earlier migration, so the
-- study-coach run could not be marked completed or failed.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

-- Duplicate uploads: the application checks the content hash first, but two simultaneous
-- identical uploads could both pass the check. Enforce it in the database too. Skipped (with a
-- NOTICE) if duplicates already exist; resolve them and re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sources WHERE metadata ? 'sha256'
     GROUP BY workspace_id, metadata->>'sha256' HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'sources has duplicate (workspace_id, sha256) rows; remove the duplicates, then re-run to create uq_sources_workspace_sha256';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sources_workspace_sha256
      ON sources (workspace_id, (metadata->>'sha256'))
      WHERE metadata ? 'sha256';
  END IF;
END $$;
