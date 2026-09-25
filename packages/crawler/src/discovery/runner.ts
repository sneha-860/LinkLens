import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type pg from "pg";
import { db as q, makeConfig, rfc3986, type LinkLensConfig } from "@linklens/core";

type Json = q.Json;
import { asQueryable } from "@linklens/db";
import { extractPage } from "../extract.js";
import { fetchPage } from "../fetcher.js";
import { CHROME_REGIONS } from "../html/region.js";
import { RedisHostThrottle } from "../redis-throttle.js";
import { RobotsStore } from "../robots-store.js";
import { makeScope } from "../scope.js";
import { systemClock, type Clock } from "../throttle.js";
import {
  findFeedLinks,
  looksLikeSitemapLink,
  maybeGunzip,
  parseFeed,
  parseLlmsTxt,
  parseSitemap,
  type ParsedSitemap,
} from "./parse.js";

/** Conventional locations probed on the seed's origin (in this order). */
export const COMMON_PATHS = {
  xmlSitemap: ["/sitemap.xml", "/sitemap_index.xml", "/sitemap.xml.gz"],
  htmlSitemap: ["/sitemap.html", "/sitemap", "/site-map", "/html-sitemap"],
  feed: ["/feed.xml", "/rss.xml", "/atom.xml", "/feed", "/index.xml"],
  llmsTxt: ["/llms.txt"],
} as const;

type Channel = q.NewDiscoveryObservation["channel"];

export interface DiscoverySummary {
  readonly runId: number;
  /** Requests made by discovery (its own cap: config.discoveryMaxFetches). */
  readonly fetches: number;
  readonly capReached: boolean;
  /** Observations recorded per channel. */
  readonly observations: Readonly<Record<Channel, number>>;
  /** Sitemap files read, and those skipped for depth. */
  readonly sitemapFiles: readonly string[];
  readonly sitemapsTooDeep: readonly string[];
  readonly htmlSitemaps: readonly string[];
  readonly feeds: readonly string[];
}

export interface DiscoveryOptions {
  readonly pool: pg.Pool;
  readonly redisUrl: string;
  /** Must match the crawl's prefix so the per-host throttle is shared. */
  readonly prefix?: string;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  /** Overrides on top of the run's stored config (e.g. a smaller discoveryMaxFetches). */
  readonly config?: Partial<LinkLensConfig>;
}

interface Doc {
  readonly url: string;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const decode = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);

/**
 * Collects the six discovery channels for a crawled run, each into discovery_observations with
 * its own channel and provenance (source_document + detail):
 *  1. link_graph: every link observation of the crawl, plus the seed;
 *  2. xml_sitemap: pages in sitemaps found at conventional paths (/sitemap.xml, …);
 *  3. robots_sitemap: pages in sitemaps declared by robots.txt `Sitemap:` lines;
 *     (both follow sitemap indexes up to sitemapMaxDepth, read .gz, skip cycles; a sitemap reached
 *     both ways credits both channels)
 *  4. html_sitemap: links in the main content of HTML sitemap pages, found by links labelled
 *     "sitemap"/"site map" and by conventional paths (a path hit must look like a sitemap);
 *  5. feed: entry links of RSS/Atom feeds from <link rel=alternate> and conventional paths;
 *  6. llms_txt: Markdown links in /llms.txt.
 * Every request obeys robots.txt and the shared per-host throttle, stays in the crawl scope,
 * is stored as a `discovery` fetch, and counts toward discoveryMaxFetches, never pageCap.
 */
export class DiscoveryRunner {
  private readonly db: q.Queryable;
  private readonly redis: Redis;

  constructor(private readonly options: DiscoveryOptions) {
    this.db = asQueryable(options.pool);
    this.redis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  async run(runId: number): Promise<DiscoverySummary> {
    const run = await q.getRun(this.db, runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    const site = await q.getSite(this.db, run.siteId);
    if (site === null) throw new Error(`site ${run.siteId} not found`);
    const config = makeConfig({ ...run.config, ...this.options.config });
    return new DiscoverySession(
      this.db,
      this.redis,
      runId,
      site.rootUrl,
      config,
      this.options,
    ).run();
  }
}

class DiscoverySession {
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly throttle: RedisHostThrottle;
  private readonly robots: RobotsStore;
  private readonly inScope: (url: URL) => boolean;
  private readonly requested = new Map<string, Promise<Doc | null>>();
  private readonly counts: Record<Channel, number> = {
    link_graph: 0,
    xml_sitemap: 0,
    robots_sitemap: 0,
    html_sitemap: 0,
    feed: 0,
    llms_txt: 0,
  };
  private fetches = 0;
  private capReached = false;
  private readonly sitemapFiles: string[] = [];
  private readonly sitemapsTooDeep: string[] = [];
  private readonly htmlSitemaps: string[] = [];
  private readonly feeds: string[] = [];

  constructor(
    private readonly db: q.Queryable,
    redis: Redis,
    private readonly runId: number,
    private readonly seedUrl: string,
    private readonly config: Readonly<LinkLensConfig>,
    options: DiscoveryOptions,
  ) {
    this.clock = options.clock ?? systemClock;
    this.fetchImpl = options.fetch ?? fetch;
    this.throttle = new RedisHostThrottle(redis, options.prefix ?? "linklens", config, this.clock);
    this.robots = new RobotsStore(db, runId, config, this.throttle, this.fetchImpl, this.clock);
    this.inScope = makeScope(new URL(seedUrl), config.includeSubdomains);
  }

  async run(): Promise<DiscoverySummary> {
    const pages = await q.listPages(this.db, this.runId);
    const links = await q.listLinkObservations(this.db, this.runId);
    const robots = await this.robots.policyFor(new URL(this.seedUrl));

    await this.collectLinkGraph(pages, links);
    await this.collectSitemaps(robots.sitemaps.map((s) => s.url));
    await this.collectHtmlSitemaps(pages, links);
    await this.collectFeeds(pages);
    await this.collectLlmsTxt();

    return {
      runId: this.runId,
      fetches: this.fetches,
      capReached: this.capReached,
      observations: { ...this.counts },
      sitemapFiles: this.sitemapFiles,
      sitemapsTooDeep: this.sitemapsTooDeep,
      htmlSitemaps: this.htmlSitemaps,
      feeds: this.feeds,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Recording and fetching
  // ------------------------------------------------------------------------------------------

  private async record(
    channel: Channel,
    rows: { url: string; source: string | null; detail: { [k: string]: Json } }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await q.insertDiscoveryObservations(
      this.db,
      rows.map((r) => ({
        runId: this.runId,
        channel,
        url: r.url,
        sourceDocument: r.source,
        detail: r.detail,
      })),
    );
    this.counts[channel] += rows.length;
  }

  private originUrl(path: string): string {
    return rfc3986.resolveReference(this.seedUrl, path);
  }

  /** Fetch a discovery document once per run (by URL, fragment dropped); null if unusable. */
  private fetchDoc(raw: string): Promise<Doc | null> {
    const key = rfc3986.stripFragment(raw);
    let pending = this.requested.get(key);
    if (pending === undefined) {
      pending = this.doFetch(key);
      this.requested.set(key, pending);
    }
    return pending;
  }

  private async doFetch(key: string): Promise<Doc | null> {
    let url: URL;
    try {
      url = new URL(key);
    } catch {
      return null;
    }
    if (!this.inScope(url)) {
      await q.insertFetch(this.db, {
        runId: this.runId,
        requestedUrl: key,
        purpose: "discovery",
        error: "discovery: outside the crawl scope, not fetched",
      });
      return null;
    }
    if (this.fetches >= this.config.discoveryMaxFetches) {
      this.capReached = true;
      return null;
    }
    this.fetches += 1;
    const o = await fetchPage(
      url,
      {
        config: this.config,
        fetch: this.fetchImpl,
        throttle: this.throttle,
        robots: (u) => this.robots.policyFor(u),
        inScope: this.inScope,
        keepAllBodies: true,
      },
      key,
    );
    if (o.kind === "blocked" && o.statusCode === null) this.fetches -= 1; // no request was sent
    const row = await q.insertFetch(this.db, {
      runId: this.runId,
      requestedUrl: o.requestedUrl,
      finalUrl: o.finalUrl,
      statusCode: o.statusCode,
      redirectChain: o.redirectChain,
      headers: o.headers,
      contentType: o.contentType,
      bytes: o.bytes,
      error: o.error,
      purpose: "discovery",
    });
    if (o.rawBody === null || o.finalUrl === null) return null;
    if (this.config.storeDiscoveryBodies || o.html !== null) {
      await q.insertFetchBody(this.db, {
        fetchId: row.id,
        runId: this.runId,
        body: Buffer.from(o.rawBody.buffer, o.rawBody.byteOffset, o.rawBody.byteLength),
        truncated: o.truncated,
        sha256: sha256(o.rawBody),
      });
    }
    return { url: key, finalUrl: o.finalUrl, contentType: o.contentType, bytes: o.rawBody };
  }

  // ------------------------------------------------------------------------------------------
  // 1. Link graph
  // ------------------------------------------------------------------------------------------

  private async collectLinkGraph(pages: q.PageRow[], links: q.LinkObservationRow[]): Promise<void> {
    const pageUrl = new Map(pages.map((p) => [p.fetchId, p.url]));
    await this.record("link_graph", [
      { url: this.seedUrl, source: null, detail: { kind: "seed" } },
      ...links
        .filter((l) => l.resolvedUrl !== null)
        .map((l) => ({
          url: l.resolvedUrl as string,
          source: pageUrl.get(l.sourceFetchId) ?? null,
          detail: {
            linkObservationId: l.id,
            anchorText: l.anchorText,
            domRegion: l.domRegion,
          },
        })),
    ]);
  }

  // ------------------------------------------------------------------------------------------
  // 2 + 3. XML sitemaps (conventional paths) and robots.txt Sitemap: directives
  // ------------------------------------------------------------------------------------------

  private readonly parsedSitemaps = new Map<
    string,
    Promise<{ doc: Doc; parsed: ParsedSitemap; gzipped: boolean } | null>
  >();

  private sitemap(url: string) {
    let p = this.parsedSitemaps.get(url);
    if (p === undefined) {
      p = (async () => {
        const doc = await this.fetchDoc(url);
        if (doc === null) return null;
        let bytes: Uint8Array;
        let gzipped: boolean;
        try {
          ({ bytes, gzipped } = maybeGunzip(doc.bytes, this.config.maxBodyBytes));
        } catch {
          return null; // corrupt or oversized gzip
        }
        const parsed = parseSitemap(decode(bytes), this.config.sitemapMaxUrls);
        if (parsed.type === "unknown") return null;
        this.sitemapFiles.push(doc.url);
        return { doc, parsed, gzipped };
      })();
      this.parsedSitemaps.set(url, p);
    }
    return p;
  }

  /** Walk sitemap indexes breadth-first from `seeds`, recording pages for `channel`. */
  private async walkSitemaps(channel: Channel, seeds: readonly string[]): Promise<void> {
    const seen = new Set<string>();
    let level = seeds.map((url) => ({ url, chain: [] as string[] }));
    for (let depth = 0; level.length > 0; depth++) {
      const next: typeof level = [];
      for (const { url, chain } of level) {
        const key = rfc3986.stripFragment(url);
        if (seen.has(key)) continue; // cycle or duplicate
        seen.add(key);
        if (depth > this.config.sitemapMaxDepth) {
          if (!this.sitemapsTooDeep.includes(key)) this.sitemapsTooDeep.push(key);
          continue;
        }
        const s = await this.sitemap(key);
        if (s === null) continue;
        const locs = s.parsed.entries.map((e) => ({
          ...e,
          url: rfc3986.resolveReference(s.doc.finalUrl, e.loc),
        }));
        if (s.parsed.type === "sitemapindex") {
          for (const l of locs) next.push({ url: l.url, chain: [...chain, key] });
          continue;
        }
        await this.record(
          channel,
          locs.map((l) => ({
            url: l.url,
            source: key,
            detail: {
              rawLoc: l.loc,
              lastmod: l.lastmod,
              depth,
              via: [...chain, key],
              gzipped: s.gzipped,
              truncated: s.parsed.truncated,
            },
          })),
        );
      }
      level = next;
    }
  }

  private async collectSitemaps(directives: readonly string[]): Promise<void> {
    const robotsUrl = this.originUrl("/robots.txt");
    const declared = directives.map((d) => rfc3986.resolveReference(robotsUrl, d));
    await this.walkSitemaps("robots_sitemap", declared);
    await this.walkSitemaps(
      "xml_sitemap",
      COMMON_PATHS.xmlSitemap.map((p) => this.originUrl(p)),
    );
  }

  // ------------------------------------------------------------------------------------------
  // 4. HTML sitemap pages
  // ------------------------------------------------------------------------------------------

  private async collectHtmlSitemaps(
    pages: q.PageRow[],
    links: q.LinkObservationRow[],
  ): Promise<void> {
    const candidates = new Map<string, "label" | "path">();
    for (const l of links) {
      if (l.resolvedUrl === null || !looksLikeSitemapLink(l.anchorText, l.rawHref)) continue;
      candidates.set(rfc3986.stripFragment(l.resolvedUrl), "label");
    }
    for (const p of COMMON_PATHS.htmlSitemap) {
      const url = this.originUrl(p);
      if (!candidates.has(url)) candidates.set(url, "path");
    }
    const crawled = new Map(pages.map((p) => [rfc3986.stripFragment(p.url), p.fetchId]));

    for (const [url, via] of candidates) {
      let html: string | null = null;
      let pageUrl = url;
      const fetchId = crawled.get(url);
      const stored = fetchId === undefined ? null : await q.getFetchBody(this.db, fetchId);
      if (stored !== null) {
        html = decode(stored.body); // already crawled: reuse the stored bytes, no new request
      } else {
        const doc = await this.fetchDoc(url);
        if (doc === null || !/html/i.test(doc.contentType ?? "")) continue;
        html = decode(doc.bytes);
        pageUrl = doc.finalUrl;
      }
      const page = extractPage(html, pageUrl);
      const titled = /\bsite\s?map\b/i.test(`${page.title ?? ""} ${page.h1 ?? ""}`);
      if (via === "path" && !titled) continue; // a path hit must look like a sitemap page
      this.htmlSitemaps.push(pageUrl);
      await this.record(
        "html_sitemap",
        page.links
          .filter((l) => !CHROME_REGIONS.has(l.domRegion))
          .map((l) => ({
            url: l.resolvedUrl,
            source: pageUrl,
            detail: { anchorText: l.anchorText, foundBy: via },
          })),
      );
    }
  }

  // ------------------------------------------------------------------------------------------
  // 5. RSS / Atom feeds
  // ------------------------------------------------------------------------------------------

  private async collectFeeds(pages: q.PageRow[]): Promise<void> {
    const candidates = new Map<string, string>(); // feed URL → how it was found
    for (const p of pages) {
      const body = await q.getFetchBody(this.db, p.fetchId);
      if (body === null) continue;
      for (const f of findFeedLinks(decode(body.body))) {
        const url = rfc3986.stripFragment(rfc3986.resolveReference(p.url, f.href));
        if (!candidates.has(url)) candidates.set(url, `link[rel=alternate] on ${p.url}`);
      }
    }
    for (const p of COMMON_PATHS.feed) {
      const url = this.originUrl(p);
      if (!candidates.has(url)) candidates.set(url, "common path");
    }

    for (const [url, foundBy] of candidates) {
      const doc = await this.fetchDoc(url);
      if (doc === null) continue;
      const feed = parseFeed(decode(doc.bytes));
      if (feed.format === "unknown") continue;
      this.feeds.push(doc.url);
      await this.record(
        "feed",
        feed.entries.map((e) => ({
          url: rfc3986.resolveReference(doc.finalUrl, e.link),
          source: doc.url,
          detail: { format: feed.format, title: e.title, rawLink: e.link, foundBy },
        })),
      );
    }
  }

  // ------------------------------------------------------------------------------------------
  // 6. llms.txt
  // ------------------------------------------------------------------------------------------

  private async collectLlmsTxt(): Promise<void> {
    for (const p of COMMON_PATHS.llmsTxt) {
      const doc = await this.fetchDoc(this.originUrl(p));
      if (doc === null) continue;
      await this.record(
        "llms_txt",
        parseLlmsTxt(decode(doc.bytes)).map((l) => ({
          url: rfc3986.resolveReference(doc.finalUrl, l.href),
          source: doc.url,
          detail: { text: l.text, section: l.section, rawHref: l.href },
        })),
      );
    }
  }
}
