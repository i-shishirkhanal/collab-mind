-- Per-source on/off switch. An inactive source stays uploaded and indexed but is ignored by chat,
-- Studio tools and agents until it is switched back on. Idempotent.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
