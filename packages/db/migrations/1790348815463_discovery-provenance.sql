-- Up Migration

-- Provenance for each discovery observation, as observed (raw): e.g. the sitemap chain and depth,
-- the raw <loc>, the feed format and entry title, the anchor text, the robots.txt line.
-- detail.kind = 'directive' marks robots.txt Sitemap: lines (they name sitemap files, not pages).
ALTER TABLE discovery_observations ADD COLUMN detail jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Why a request was made. Only 'crawl' fetches count toward pageCap; 'discovery' fetches have
-- their own cap (config.discoveryMaxFetches).
ALTER TABLE fetches ADD COLUMN purpose text NOT NULL DEFAULT 'crawl'
  CHECK (purpose IN ('crawl', 'robots', 'discovery'));
UPDATE fetches SET purpose = 'robots' WHERE requested_url LIKE '%/robots.txt';

-- A view's SELECT * is expanded when it is created: recreate it so it includes `purpose`.
CREATE OR REPLACE VIEW final_fetches AS
SELECT DISTINCT ON (run_id, requested_url) *
FROM fetches
ORDER BY run_id, requested_url, attempt DESC, id DESC;

-- Down Migration

DROP VIEW final_fetches;
ALTER TABLE fetches DROP COLUMN purpose;
CREATE VIEW final_fetches AS
SELECT DISTINCT ON (run_id, requested_url) *
FROM fetches
ORDER BY run_id, requested_url, attempt DESC, id DESC;
ALTER TABLE discovery_observations DROP COLUMN detail;
