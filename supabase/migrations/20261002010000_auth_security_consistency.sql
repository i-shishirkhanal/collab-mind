-- Phase 1: email authentication, session storage and schema consistency.
--
-- Safe to run repeatedly and on a database that already holds data: every
-- statement is IF NOT EXISTS / guarded, nothing is dropped, and constraints that
-- existing rows might violate are added NOT VALID and only validated when the
-- data allows it (otherwise a NOTICE says what to fix).

-- ── users: credentials + verification ──────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Emails are compared case-insensitively. Lower-case existing rows where that
-- cannot collide with another account, then enforce uniqueness on lower(email).
UPDATE users u
   SET email = lower(u.email)
 WHERE u.email <> lower(u.email)
   AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND lower(o.email) = lower(u.email));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY lower(email) HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'users has emails that differ only by case; merge them, then re-run to create uq_users_email_lower';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));
  END IF;
END $$;

-- Pre-existing accounts were created without a password or a verified mailbox
-- (demo / passwordless sign-in). They keep all their data but cannot sign in
-- until the owner of the mailbox uses "forgot password", which also verifies the
-- address. Nothing is auto-verified.

-- ── server-side sessions (logout / revocation) ─────────────────────────────
CREATE TABLE IF NOT EXISTS auth_sessions (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    user_agent  TEXT,
    ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user    ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at);

-- ── single-use email tokens (verification, password reset) ─────────────────
-- Only a SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS auth_tokens (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     VARCHAR(20) NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens (user_id, purpose);

-- Backend connects as the table owner; the public Supabase keys must not read these.
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens   ENABLE ROW LEVEL SECURITY;

-- ── workspace_members: roles ───────────────────────────────────────────────
-- The code uses member / admin / owner; the original schema only documented
-- owner / member. Unknown roles become the least-privileged 'member'.
UPDATE workspace_members SET role = 'member' WHERE role NOT IN ('member', 'admin', 'owner');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_role_check') THEN
    ALTER TABLE workspace_members
      ADD CONSTRAINT workspace_members_role_check CHECK (role IN ('member', 'admin', 'owner'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members (user_id);

-- ── chat_messages / sources / agent_runs / source_chunks ───────────────────
UPDATE chat_messages SET role = 'assistant' WHERE role NOT IN ('user', 'assistant') AND user_id IS NULL;
UPDATE chat_messages SET role = 'user'      WHERE role NOT IN ('user', 'assistant');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_role_check') THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_role_check CHECK (role IN ('user', 'assistant'));
  END IF;
END $$;

-- Column the AI service already relies on (it used to add it at startup).
ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS location_label TEXT;

-- Every row must belong to a workspace; a NULL workspace_id escapes both the
-- cascade delete and workspace-scoped queries. Only enforced when no NULLs exist.
DO $$
DECLARE
  t TEXT;
  n BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sources', 'source_chunks', 'chat_messages', 'agent_runs'] LOOP
    EXECUTE format('SELECT COUNT(*) FROM %I WHERE workspace_id IS NULL', t) INTO n;
    IF n = 0 THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id SET NOT NULL', t);
    ELSE
      RAISE NOTICE '% has % rows with NULL workspace_id; assign or delete them, then re-run to enforce NOT NULL', t, n;
    END IF;
  END LOOP;
END $$;

-- Chunks can only point at a source of the SAME workspace (cross-workspace
-- chunk leakage is impossible at the database level).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_sources_id_workspace') THEN
    ALTER TABLE sources ADD CONSTRAINT uq_sources_id_workspace UNIQUE (id, workspace_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_source_chunks_source_workspace') THEN
    ALTER TABLE source_chunks
      ADD CONSTRAINT fk_source_chunks_source_workspace
      FOREIGN KEY (source_id, workspace_id) REFERENCES sources (id, workspace_id) ON DELETE CASCADE
      NOT VALID;
  END IF;

  BEGIN
    ALTER TABLE source_chunks VALIDATE CONSTRAINT fk_source_chunks_source_workspace;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'source_chunks has rows whose workspace differs from their source; new rows are enforced, fix old rows then VALIDATE CONSTRAINT fk_source_chunks_source_workspace';
  END;
END $$;

-- ── indexes for the workspace-scoped queries the app actually runs ─────────
CREATE INDEX IF NOT EXISTS idx_sources_workspace_created   ON sources (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_ws_created    ON chat_messages (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace        ON agent_runs (workspace_id);
CREATE INDEX IF NOT EXISTS idx_source_chunks_workspace     ON source_chunks (workspace_id, source_id);
