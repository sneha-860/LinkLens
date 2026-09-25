-- Up Migration

-- The background job that ranks an audit's fixes under every policy (for the sensitivity table).
-- It is kept here, not in memory, so a restarted API resumes it and every instance reports it.
CREATE TABLE policy_jobs (
  run_id     bigint      PRIMARY KEY REFERENCES audits (run_id),
  status     text        NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  done       text[]      NOT NULL DEFAULT '{}',
  current    text,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE policy_jobs;
