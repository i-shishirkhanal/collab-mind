-- Saved Studio results (flashcards, quiz, study guide, report), so a refresh no longer loses them.
-- One row per generation; the backend keeps the 20 most recent per workspace and tool. Idempotent.
CREATE TABLE IF NOT EXISTS studio_outputs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    kind          VARCHAR(20) NOT NULL CHECK (kind IN ('flashcards', 'quiz', 'guide', 'report')),
    params        JSONB NOT NULL DEFAULT '{}',
    content       JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_studio_outputs_latest ON studio_outputs (workspace_id, kind, created_at DESC);

-- Same model as the other tables: all access goes through the backend.
ALTER TABLE studio_outputs ENABLE ROW LEVEL SECURITY;
