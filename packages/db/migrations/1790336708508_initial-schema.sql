-- Up Migration

-- Raw tables (sites, runs, fetches, pages, link_observations, discovery_observations) store data
-- exactly as observed: no canonicalisation on write. Derived data lives only in `artefacts`,
-- which always carries the run id and the canonicalisation policy version.

CREATE TABLE sites (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  root_url           text        NOT NULL,
  architecture_class text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id     bigint      NOT NULL REFERENCES sites (id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  config_json jsonb       NOT NULL,
  status      text        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  seed        integer     NOT NULL,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX runs_site_id_idx ON runs (site_id);

CREATE TABLE fetches (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         bigint      NOT NULL REFERENCES runs (id),
  requested_url  text        NOT NULL,
  final_url      text,
  status_code    integer,
  redirect_chain jsonb       NOT NULL DEFAULT '[]'::jsonb,
  headers        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  content_type   text,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  bytes          integer     CHECK (bytes IS NULL OR bytes >= 0),
  error          text
);
CREATE INDEX fetches_run_id_idx ON fetches (run_id);

CREATE TABLE pages (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         bigint NOT NULL REFERENCES runs (id),
  fetch_id       bigint NOT NULL UNIQUE REFERENCES fetches (id),
  url            text   NOT NULL,
  title          text,
  h1             text,
  headings       jsonb  NOT NULL DEFAULT '[]'::jsonb,
  meta_canonical text,
  meta_robots    text,
  body_text      text,
  paragraphs     jsonb  NOT NULL DEFAULT '[]'::jsonb,
  lang           text
);
CREATE INDEX pages_run_id_idx ON pages (run_id);

CREATE TABLE link_observations (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id             bigint  NOT NULL REFERENCES runs (id),
  source_fetch_id    bigint  NOT NULL REFERENCES fetches (id),
  raw_href           text    NOT NULL,
  resolved_url       text,
  anchor_text        text,
  rel                text,
  dom_region         text,
  dom_path           text,
  template_signature text,
  position_index     integer NOT NULL CHECK (position_index >= 0)
);
CREATE INDEX link_observations_run_id_idx ON link_observations (run_id);
CREATE INDEX link_observations_source_fetch_id_idx ON link_observations (source_fetch_id);

CREATE TABLE discovery_observations (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          bigint      NOT NULL REFERENCES runs (id),
  channel         text        NOT NULL CHECK (channel IN (
                    'link_graph', 'xml_sitemap', 'robots_sitemap',
                    'html_sitemap', 'feed', 'llms_txt')),
  url             text        NOT NULL,
  source_document text,
  observed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discovery_observations_run_channel_idx ON discovery_observations (run_id, channel);

CREATE TABLE artefacts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         bigint      NOT NULL REFERENCES runs (id),
  policy_version text        NOT NULL CHECK (policy_version <> ''),
  kind           text        NOT NULL CHECK (kind <> ''),
  payload        jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artefacts_run_policy_kind_idx ON artefacts (run_id, policy_version, kind);

-- Append-only enforcement. Row triggers block UPDATE/DELETE; a statement trigger blocks TRUNCATE
-- (row triggers do not fire on TRUNCATE).
CREATE FUNCTION linklens_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER link_observations_append_only
  BEFORE UPDATE OR DELETE ON link_observations
  FOR EACH ROW EXECUTE FUNCTION linklens_reject_mutation();
CREATE TRIGGER link_observations_no_truncate
  BEFORE TRUNCATE ON link_observations
  FOR EACH STATEMENT EXECUTE FUNCTION linklens_reject_mutation();

CREATE TRIGGER discovery_observations_append_only
  BEFORE UPDATE OR DELETE ON discovery_observations
  FOR EACH ROW EXECUTE FUNCTION linklens_reject_mutation();
CREATE TRIGGER discovery_observations_no_truncate
  BEFORE TRUNCATE ON discovery_observations
  FOR EACH STATEMENT EXECUTE FUNCTION linklens_reject_mutation();

-- Down Migration

DROP TABLE artefacts;
DROP TABLE discovery_observations;
DROP TABLE link_observations;
DROP TABLE pages;
DROP TABLE fetches;
DROP TABLE runs;
DROP TABLE sites;
DROP FUNCTION linklens_reject_mutation();
