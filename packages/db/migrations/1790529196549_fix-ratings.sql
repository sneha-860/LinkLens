-- Up Migration

-- E8 human ratings from the dashboard's rating page. A rater rates the items of a blind
-- `rating-sample` artefact (sampled top fixes, no scores shown). Append-only: changing an answer
-- adds a row, and the latest row per (sample, rater, item) is the rater's answer.
CREATE TABLE fix_ratings (
  id                 bigserial PRIMARY KEY,
  run_id             bigint NOT NULL REFERENCES runs (id),
  sample_artefact_id bigint NOT NULL REFERENCES artefacts (id),
  -- The fix id (e.g. add-link:<donor>-><target>), as listed in the sample.
  item_id            text NOT NULL CHECK (item_id <> ''),
  -- The rater slot (two raters per sample) and the name they gave.
  rater              text NOT NULL CHECK (rater IN ('A', 'B')),
  rater_name         text NOT NULL CHECK (rater_name <> ''),
  relevant           boolean NOT NULL,
  -- Placement quality of the suggested paragraph and anchor; 'na' when not relevant or when
  -- no placement was suggested.
  placement          text NOT NULL CHECK (placement IN ('good', 'acceptable', 'poor', 'na')),
  rated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fix_ratings_sample_idx ON fix_ratings (sample_artefact_id, rater, item_id, id);

CREATE TRIGGER fix_ratings_append_only
  BEFORE UPDATE OR DELETE ON fix_ratings
  FOR EACH ROW EXECUTE FUNCTION linklens_reject_mutation();
CREATE TRIGGER fix_ratings_no_truncate
  BEFORE TRUNCATE ON fix_ratings
  FOR EACH STATEMENT EXECUTE FUNCTION linklens_reject_mutation();

-- Down Migration

DROP TABLE fix_ratings;
