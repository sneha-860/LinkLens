-- Up Migration

-- An audit is a run driven through the whole pipeline by the API. Its stages are tracked so the
-- pipeline can resume after a failure or a restart: completed stages are never re-run.
CREATE TABLE audits (
  run_id        bigint      PRIMARY KEY REFERENCES runs (id),
  policy        text        NOT NULL CHECK (policy IN ('P0', 'P1', 'P2', 'P3', 'P4', 'P5')),
  options       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status        text        NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  current_stage text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_stages (
  run_id      bigint           NOT NULL REFERENCES audits (run_id),
  stage       text             NOT NULL,
  position    integer          NOT NULL,
  status      text             NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at  timestamptz,
  finished_at timestamptz,
  duration_ms double precision,
  detail      jsonb            NOT NULL DEFAULT '{}'::jsonb,
  error       text,
  PRIMARY KEY (run_id, stage)
);

-- Down Migration

DROP TABLE audit_stages;
DROP TABLE audits;
