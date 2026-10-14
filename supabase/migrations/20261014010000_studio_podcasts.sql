CREATE TABLE studio_podcasts (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    params JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','scripting','synthesizing','ready','failed')),
    transcript JSONB NOT NULL DEFAULT '[]',
    citations JSONB NOT NULL DEFAULT '[]',
    warnings JSONB NOT NULL DEFAULT '[]',
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_studio_podcasts_workspace ON studio_podcasts(workspace_id, created_at DESC);
-- Prevent duplicate expensive runs, including across AI processes.
CREATE UNIQUE INDEX uq_studio_podcasts_running ON studio_podcasts(workspace_id)
    WHERE status IN ('queued','scripting','synthesizing');
ALTER TABLE studio_podcasts ENABLE ROW LEVEL SECURITY;
