-- Messaging (direct + group), read receipts, attachments and call history.
-- Additive only: no existing table is altered or dropped.
--
-- Access model: the Express backend connects as the table owner (DATABASE_URL)
-- and enforces conversation membership in code. RLS is enabled with NO policies
-- so the public anon/authenticated Supabase keys cannot read or write any of
-- these tables directly.

CREATE TABLE IF NOT EXISTS conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type            VARCHAR(10) NOT NULL CHECK (type IN ('direct', 'group')),
    name            VARCHAR(120),
    avatar_url      TEXT,
    -- Sorted "<uuidA>:<uuidB>" for direct chats so a pair can only have one thread.
    direct_key      TEXT UNIQUE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT direct_has_key CHECK ((type = 'direct') = (direct_key IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Read pointer: a message is "read" by this member when created_at <= last_read_at.
    last_read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members (user_id);

CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    kind            VARCHAR(10) NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'file', 'system')),
    body            TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
    attachment_path TEXT,
    attachment_name TEXT,
    attachment_type TEXT,
    attachment_size BIGINT,
    reply_to_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
    ON messages (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS calls (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    started_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    kind            VARCHAR(10) NOT NULL CHECK (kind IN ('audio', 'video')),
    -- ringing -> active -> ended, or ringing -> missed / declined (nobody joined)
    status          VARCHAR(10) NOT NULL DEFAULT 'ringing'
                    CHECK (status IN ('ringing', 'active', 'ended', 'missed', 'declined')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at     TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_calls_conversation_created ON calls (conversation_id, created_at DESC);
-- At most one live call per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_call_per_conversation
    ON calls (conversation_id) WHERE status IN ('ringing', 'active');

CREATE TABLE IF NOT EXISTS call_participants (
    call_id   UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status    VARCHAR(10) NOT NULL DEFAULT 'invited'
              CHECK (status IN ('invited', 'joined', 'declined', 'left', 'missed')),
    joined_at TIMESTAMPTZ,
    left_at   TIMESTAMPTZ,
    PRIMARY KEY (call_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants (user_id);

ALTER TABLE conversations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls                ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_participants    ENABLE ROW LEVEL SECURITY;

-- Private bucket for chat attachments. Objects are only reachable through
-- short-lived signed URLs minted by the backend after a membership check.
-- Guarded so the migration also runs on plain Postgres (no Supabase storage schema).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit)
    VALUES ('chat-files', 'chat-files', false, 26214400)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
