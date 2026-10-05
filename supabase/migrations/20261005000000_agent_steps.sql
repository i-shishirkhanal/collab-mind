-- Agentic layer: a per-step log every workspace member can read, plus the run columns the generic
-- agent engine (ai/agents/engine.py) needs. Idempotent.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS goal       TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS step_count INTEGER NOT NULL DEFAULT 0;

-- 'running' = the ReAct loop is working; 'rejected' = the owner declined the approval checkpoint.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('started', 'analyzing', 'planning', 'awaiting_approval', 'generating',
                    'running', 'completed', 'failed', 'rejected'));

CREATE TABLE IF NOT EXISTS agent_steps (
    id          BIGSERIAL PRIMARY KEY,
    run_id      UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_no     INTEGER NOT NULL,
    kind        VARCHAR(20) NOT NULL CHECK (kind IN ('thought', 'tool_call', 'observation', 'approval', 'final', 'error')),
    tool_name   VARCHAR(60),
    content     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps (run_id, id);

-- Same model as the other tables: all access goes through the backend, which checks membership.
ALTER TABLE agent_steps ENABLE ROW LEVEL SECURITY;

-- The reaper and the one-run-at-a-time guard now also see 'running'.
DROP INDEX IF EXISTS index_agent_runs_active;
CREATE INDEX IF NOT EXISTS index_agent_runs_active
  ON agent_runs (created_at) WHERE status NOT IN ('completed', 'failed', 'rejected');
