-- Up Migration

-- Runs can be cancelled gracefully by the crawl orchestrator.
ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'));

-- Down Migration

UPDATE runs SET status = 'failed' WHERE status = 'cancelled';
ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed'));
