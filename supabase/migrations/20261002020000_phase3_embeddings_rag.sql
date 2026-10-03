-- Phase 3: BGE-M3 embeddings (1024-d), hybrid retrieval, LLM usage accounting.
--
-- DESTRUCTIVE for existing chunks: vectors produced by the previous setup
-- (Gemini text-embedding-004 or the hash-based dev fallback, 768-d) live in a
-- different vector space from BGE-M3 and cannot be converted. They are
-- deleted, and the affected sources are flagged so they get re-indexed with
-- `python -m scripts.reindex` (ai/scripts/reindex.py). Source files and
-- source rows are kept.
--
-- Safe to run twice: the destructive block only runs while the column is not
-- already vector(1024).

DO $$
DECLARE
    current_dim integer;
BEGIN
    SELECT atttypmod INTO current_dim
    FROM pg_attribute
    WHERE attrelid = 'source_chunks'::regclass AND attname = 'embedding';

    IF current_dim IS DISTINCT FROM 1024 THEN
        DROP INDEX IF EXISTS index_source_chunks_on_embedding;
        DELETE FROM source_chunks;
        UPDATE sources
           SET status = 'failed',
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'error', 'Re-indexing required: the embedding model changed to BGE-M3.',
                   'stage', 'failed',
                   'needs_reindex', true),
               updated_at = NOW()
         WHERE status = 'ready';
        ALTER TABLE source_chunks ALTER COLUMN embedding TYPE vector(1024);
    END IF;
END $$;

-- Citation location ("Page 3", "Slide 2"...). The baseline migrations lack it; the AI
-- service previously added it at startup only.
ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS location_label TEXT;
ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS embedding_dim INT;

-- Keyword side of hybrid retrieval. 'simple' = language-neutral (BGE-M3 is multilingual).
ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS fts tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
CREATE INDEX IF NOT EXISTS index_source_chunks_on_fts ON source_chunks USING gin (fts);

CREATE INDEX IF NOT EXISTS index_source_chunks_on_embedding
    ON source_chunks USING hnsw (embedding vector_cosine_ops);

-- Which provider/model served each request, and token usage when the provider reports it.
CREATE TABLE IF NOT EXISTS llm_usage (
    id BIGSERIAL PRIMARY KEY,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,              -- chat | summarize | flashcards | quiz | study_guide | report | agent_*
    task TEXT NOT NULL,              -- chat | study | research
    provider TEXT NOT NULL,
    tier TEXT NOT NULL,              -- flash | pro (tier actually used)
    model_requested TEXT NOT NULL,
    model_used TEXT NOT NULL,        -- as reported by the provider
    prompt_tokens INT,
    completion_tokens INT,
    total_tokens INT,
    reasoning_tokens INT,
    latency_ms INT,
    attempts INT NOT NULL DEFAULT 1,
    fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
    fallback_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS index_llm_usage_workspace ON llm_usage (workspace_id, created_at DESC);
