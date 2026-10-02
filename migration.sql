CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE workspaces (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    avatar_url TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE workspace_members (
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member', -- 'owner', 'member'
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sources (
    id UUID PRIMARY KEY,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    url TEXT,
    metadata JSONB,
    status VARCHAR(50) DEFAULT 'processing', -- processing, ready, error
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- BGE-M3 dense vectors are 1024-d (must equal EMBEDDING_DIM in the AI service).
CREATE TABLE source_chunks (
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    page_number INT,
    location_label TEXT, -- "Page 3", "Slide 2", "Sheet: Yield", "Section: Methods"
    embedding vector(1024) NOT NULL,
    embedding_model TEXT,
    embedding_dim INT,
    fts tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
    PRIMARY KEY (source_id, chunk_index)
);

-- Create an HNSW index for fast nearest-neighbour queries
CREATE INDEX index_source_chunks_on_embedding
ON source_chunks USING hnsw (embedding vector_cosine_ops)
WHERE workspace_id IS NOT NULL; -- Partial index helps isolate

CREATE INDEX index_source_chunks_on_fts ON source_chunks USING gin (fts);

CREATE TABLE chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    role VARCHAR(50) NOT NULL, -- 'user', 'assistant'
    content TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE agent_runs (
    id UUID PRIMARY KEY,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    agent_type VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL,
    result JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Which provider/model served each request, plus token usage when reported.
CREATE TABLE llm_usage (
    id BIGSERIAL PRIMARY KEY,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL, task TEXT NOT NULL,
    provider TEXT NOT NULL, tier TEXT NOT NULL,
    model_requested TEXT NOT NULL, model_used TEXT NOT NULL,
    prompt_tokens INT, completion_tokens INT, total_tokens INT, reasoning_tokens INT,
    latency_ms INT, attempts INT NOT NULL DEFAULT 1,
    fallback_used BOOLEAN NOT NULL DEFAULT FALSE, fallback_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX index_llm_usage_workspace ON llm_usage (workspace_id, created_at DESC);
