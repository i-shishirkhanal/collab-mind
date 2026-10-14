-- Annotations anchor to a snapshot of an indexed passage, so reindexing cannot silently move a highlight.
CREATE TABLE source_annotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source_id UUID NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_content TEXT NOT NULL,
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
    quote TEXT NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 4000),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (source_id, workspace_id) REFERENCES sources(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_source_annotations_source ON source_annotations(workspace_id, source_id, created_at);

CREATE TABLE annotation_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    annotation_id UUID NOT NULL REFERENCES source_annotations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_annotation_comments_thread ON annotation_comments(annotation_id, created_at);

-- A persistent inbox: mentions remain visible when a teammate was offline.
CREATE TABLE annotation_mentions (
    comment_id UUID NOT NULL REFERENCES annotation_comments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMPTZ,
    PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX idx_annotation_mentions_user ON annotation_mentions(user_id);

-- Browser clients never access these tables directly; the backend enforces workspace membership.
ALTER TABLE source_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotation_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotation_mentions ENABLE ROW LEVEL SECURITY;
