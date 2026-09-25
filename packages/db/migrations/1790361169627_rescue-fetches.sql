-- Up Migration

-- 'rescue' fetches: orphan pages (found by sitemaps, feeds, llms.txt… but linked from nowhere)
-- fetched after discovery so their text can be scored for rescue donors. Their pages rows never
-- feed the link graph, which is built from 'crawl' fetches only.
ALTER TABLE fetches DROP CONSTRAINT fetches_purpose_check;
ALTER TABLE fetches ADD CONSTRAINT fetches_purpose_check
  CHECK (purpose IN ('crawl', 'robots', 'discovery', 'rescue'));

-- Down Migration

ALTER TABLE fetches DROP CONSTRAINT fetches_purpose_check;
ALTER TABLE fetches ADD CONSTRAINT fetches_purpose_check
  CHECK (purpose IN ('crawl', 'robots', 'discovery'));
