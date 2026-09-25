-- Up Migration

-- Every attempt at a URL is its own fetches row; `attempt` numbers them (1 = first try).
ALTER TABLE fetches ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1);

-- The outcome that counts for each URL in a run: its last attempt.
CREATE VIEW final_fetches AS
SELECT DISTINCT ON (run_id, requested_url) *
FROM fetches
ORDER BY run_id, requested_url, attempt DESC, id DESC;

-- Raw response bytes of 2xx HTML fetches, exactly as received (up to maxBodyBytes), so page
-- extraction can be re-run without re-crawling. Append-only like the other raw observations.
CREATE TABLE fetch_bodies (
  fetch_id   bigint      PRIMARY KEY REFERENCES fetches (id),
  run_id     bigint      NOT NULL REFERENCES runs (id),
  body       bytea       NOT NULL,
  truncated  boolean     NOT NULL,
  sha256     text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fetch_bodies_run_id_idx ON fetch_bodies (run_id);

CREATE TRIGGER fetch_bodies_append_only
  BEFORE UPDATE OR DELETE ON fetch_bodies
  FOR EACH ROW EXECUTE FUNCTION linklens_reject_mutation();
CREATE TRIGGER fetch_bodies_no_truncate
  BEFORE TRUNCATE ON fetch_bodies
  FOR EACH STATEMENT EXECUTE FUNCTION linklens_reject_mutation();

-- Down Migration

DROP TABLE fetch_bodies;
DROP VIEW final_fetches;
ALTER TABLE fetches DROP COLUMN attempt;
