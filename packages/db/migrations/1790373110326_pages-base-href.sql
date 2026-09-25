-- Up Migration

-- The document base a page's <base href> sets (resolved), so rel=canonical (P5) and other
-- page-relative references resolve as a browser would. NULL: the page has no <base href>.
ALTER TABLE pages ADD COLUMN base_href text;

-- Down Migration

ALTER TABLE pages DROP COLUMN base_href;
