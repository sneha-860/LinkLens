-- Up Migration

-- Optional analytics import (CSV: source_url, target_url, clicks), stored raw: URLs exactly as
-- written in the file, one row per CSV line. When a run has rows here, prominence uses the
-- clicks instead of the structural proxy for the source nodes they cover.
CREATE TABLE analytics_clicks (
  id              bigserial PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES runs (id),
  source_url      text NOT NULL,
  target_url      text NOT NULL,
  clicks          bigint NOT NULL CHECK (clicks >= 0),
  -- The imported file (name or label) and the CSV line (1 = header).
  source_document text,
  line_number     integer NOT NULL CHECK (line_number >= 2),
  imported_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_clicks_run_idx ON analytics_clicks (run_id);

CREATE TRIGGER analytics_clicks_append_only
  BEFORE UPDATE OR DELETE ON analytics_clicks
  FOR EACH ROW EXECUTE FUNCTION linklens_reject_mutation();
CREATE TRIGGER analytics_clicks_no_truncate
  BEFORE TRUNCATE ON analytics_clicks
  FOR EACH STATEMENT EXECUTE FUNCTION linklens_reject_mutation();

-- Down Migration

DROP TABLE analytics_clicks;
