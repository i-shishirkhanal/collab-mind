-- Workspace invitations. Adding someone by email no longer makes them a member immediately (which exposed
-- their name and email to the workspace without consent and revealed which addresses are registered):
-- it creates a pending invitation that the invitee accepts or declines.
CREATE TABLE IF NOT EXISTS workspace_invites (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    invited_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    role             VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, invited_user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_user ON workspace_invites (invited_user_id);

-- Same model as the other tables: all access goes through the backend.
ALTER TABLE workspace_invites ENABLE ROW LEVEL SECURITY;
