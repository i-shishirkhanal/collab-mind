-- Constrain status columns to the values the services actually write.
-- Idempotent. Legacy 'error' (mentioned in the initial schema comment) is normalised to 'failed'.

UPDATE sources SET status = 'failed' WHERE status = 'error';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_status_check') THEN
    IF EXISTS (SELECT 1 FROM sources WHERE status IS NULL OR status NOT IN ('processing', 'ready', 'failed')) THEN
      RAISE NOTICE 'sources has unexpected status values; fix them, then re-run to add sources_status_check';
    ELSE
      ALTER TABLE sources ADD CONSTRAINT sources_status_check
        CHECK (status IN ('processing', 'ready', 'failed'));
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_status_check') THEN
    IF EXISTS (SELECT 1 FROM agent_runs
                WHERE status NOT IN ('started', 'analyzing', 'planning', 'awaiting_approval',
                                     'generating', 'completed', 'failed')) THEN
      RAISE NOTICE 'agent_runs has unexpected status values; fix them, then re-run to add agent_runs_status_check';
    ELSE
      ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
        CHECK (status IN ('started', 'analyzing', 'planning', 'awaiting_approval',
                          'generating', 'completed', 'failed'));
    END IF;
  END IF;
END $$;

-- Lets the reaper (ai/agents/reaper.py) find stuck runs cheaply.
CREATE INDEX IF NOT EXISTS index_agent_runs_active
  ON agent_runs (created_at) WHERE status NOT IN ('completed', 'failed');
