-- Up Migration

-- meta robots says "nofollow" (or "none") on this page. Recorded only: the page's links are still
-- all stored in link_observations. meta_robots keeps the raw value.
ALTER TABLE pages ADD COLUMN nofollow boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE pages DROP COLUMN nofollow;
