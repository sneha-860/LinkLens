import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { Redis } from "ioredis";
import type pg from "pg";
import { db as q, discovery as d, type LinkLensConfig } from "@linklens/core";
import { asQueryable, createPool } from "@linklens/db";
import { DiscoveryRunner, type DiscoverySummary } from "../src/discovery/runner.js";
import { CrawlOrchestrator } from "../src/orchestrator.js";
import { startFixtureServer } from "./fixtures/server.js";

const UA = "LinkLensBot/0.1 (+https://linklens.test/bot)";
const BASE_CONFIG: Partial<LinkLensConfig> = {
  userAgent: UA,
  crawlDelayMs: 0,
  fetchTimeoutMs: 300,
  retryBackoffMs: 50,
  maxRedirects: 3,
};

let pool: pg.Pool;
let db: q.Queryable;
let redis: Redis;

beforeAll(() => {
  pool = createPool(inject("databaseUrl"));
  db = asQueryable(pool);
  redis = new Redis(inject("redisUrl"));
});
afterAll(async () => {
  await pool.end();
  await redis.quit();
});

/** A fixture server + crawl orchestrator + discovery runner sharing one Redis prefix. */
async function environment() {
  const prefix = `linklens_test_${randomBytes(4).toString("hex")}`;
  const dispatches: { url: string; at: number }[] = [];
  const recordingFetch: typeof fetch = (input, init) => {
    dispatches.push({
      url: input instanceof Request ? input.url : input.toString(),
      at: performance.now(),
    });
    return fetch(input, init);
  };
  const server = await startFixtureServer();
  const orchestrator = new CrawlOrchestrator({
    pool,
    redisUrl: inject("redisUrl"),
    prefix,
    fetch: recordingFetch,
  });
  const discovery = (config: Partial<LinkLensConfig> = {}) =>
    new DiscoveryRunner({
      pool,
      redisUrl: inject("redisUrl"),
      prefix,
      fetch: recordingFetch,
      config,
    });
  return {
    server,
    orchestrator,
    discovery,
    dispatches,
    close: async () => {
      await orchestrator.close();
      await server.close();
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length > 0) await redis.del(...keys);
    },
  };
}

describe("discovery on the fixture site", () => {
  let env: Awaited<ReturnType<typeof environment>>;
  let o: string;
  let runId: number;
  let summary: DiscoverySummary;
  let crawlRequests: number;
  let crawlDispatches: number;
  let obs: q.DiscoveryObservationRow[];
  const byChannel = (c: q.DiscoveryObservationRow["channel"]) =>
    obs.filter((x) => x.channel === c && x.detail["kind"] !== "directive");
  const paths = (rows: { url: string }[]) =>
    [...new Set(rows.map((r) => r.url.replace(o, "")))].sort();

  beforeAll(async () => {
    env = await environment();
    o = env.server.origin;
    const crawl = await env.orchestrator.crawl(`${o}/`, { config: BASE_CONFIG });
    runId = crawl.runId;
    crawlRequests = env.server.requests.length;
    crawlDispatches = env.dispatches.length;
    const runner = env.discovery();
    try {
      summary = await runner.run(runId);
    } finally {
      await runner.close();
    }
    obs = await q.listDiscoveryObservations(db, runId);
  });
  afterAll(() => env.close());

  const discoveryRequests = () => env.server.requests.slice(crawlRequests).map((r) => r.path);

  it("reads sitemap indexes, .gz sitemaps, skips cycles and stops at sitemapMaxDepth", () => {
    expect([...summary.sitemapFiles].map((u) => u.replace(o, "")).sort()).toEqual([
      "/sitemap.xml",
      "/sitemaps/index.xml",
      "/sitemaps/nested-1.xml",
      "/sitemaps/nested-2.xml",
      "/sitemaps/nested-3.xml",
      "/sitemaps/pages.xml",
      "/sitemaps/posts.xml.gz",
    ]);
    expect(summary.sitemapsTooDeep).toEqual([`${o}/sitemaps/nested-4.xml`]);
    expect(discoveryRequests()).not.toContain("/sitemaps/nested-4.xml");
    expect(obs.some((x) => x.url.endsWith("/too-deep.html"))).toBe(false);
  });

  it("robots_sitemap: pages of sitemaps declared in robots.txt, with the index chain", () => {
    const rows = byChannel("robots_sitemap");
    expect(paths(rows)).toEqual([
      "/",
      "/about.html",
      "/blog/post-1.html",
      "/blog/post-2.html",
      "/sitemap-orphan.html",
    ]);
    const orphan = rows.find((r) => r.url.endsWith("/sitemap-orphan.html"));
    expect(orphan).toMatchObject({
      sourceDocument: `${o}/sitemaps/pages.xml`,
      detail: {
        rawLoc: "/sitemap-orphan.html",
        depth: 1,
        via: [`${o}/sitemaps/index.xml`, `${o}/sitemaps/pages.xml`],
      },
    });
    expect(rows.find((r) => r.url.endsWith("/post-2.html"))?.detail).toMatchObject({
      gzipped: true,
    });
  });

  it("xml_sitemap: pages of sitemaps at conventional paths", () => {
    const rows = byChannel("xml_sitemap");
    expect(paths(rows)).toEqual(["/", "/about.html", "/blog/post-1.html", "/orphan.html"]);
    expect(rows.find((r) => r.url.endsWith("/orphan.html"))?.detail).toMatchObject({
      lastmod: "2026-01-01",
      depth: 0,
    });
  });

  it("html_sitemap: main-content links of HTML sitemaps found by label and by path", () => {
    expect(summary.htmlSitemaps).toEqual([`${o}/site-map/`, `${o}/sitemap.html`]);
    const rows = byChannel("html_sitemap");
    const bySource = (p: string) => paths(rows.filter((r) => r.sourceDocument === o + p));
    expect(bySource("/site-map/")).toEqual(["/", "/about.html", "/blog/", "/deep/1.html"]);
    expect(bySource("/sitemap.html")).toEqual(["/about.html", "/html-only.html"]); // nav "Home" stripped
    expect(rows.find((r) => r.sourceDocument === `${o}/site-map/`)?.detail).toMatchObject({
      foundBy: "label",
    });
    // /site-map/ was crawled: its stored body is reused, not requested again.
    expect(discoveryRequests()).not.toContain("/site-map/");
  });

  it("feed: RSS from <link rel=alternate>, Atom from a conventional path", () => {
    expect(summary.feeds).toEqual([`${o}/feed.xml`, `${o}/atom.xml`]);
    const rows = byChannel("feed");
    expect(paths(rows)).toEqual(["/blog/post-1.html", "/blog/post-2.html", "/rss-orphan.html"]);
    expect(rows.find((r) => r.url.endsWith("/rss-orphan.html"))?.detail).toMatchObject({
      format: "rss",
      title: "Only in the feed",
      foundBy: `link[rel=alternate] on ${o}/`,
    });
    expect(rows.find((r) => r.url.endsWith("/post-2.html"))?.detail).toMatchObject({
      format: "atom",
      foundBy: "common path",
    });
  });

  it("llms_txt: Markdown links with their section", () => {
    const rows = byChannel("llms_txt");
    expect(paths(rows)).toEqual(["/about.html", "/deep/6.html", "/llms-orphan.html"]);
    expect(rows.find((r) => r.url.endsWith("/llms-orphan.html"))?.detail).toMatchObject({
      text: "Only listed here",
      section: "Optional",
    });
  });

  it("link_graph: the seed plus every link observation of the crawl", async () => {
    const links = await q.listLinkObservations(db, runId);
    const rows = byChannel("link_graph");
    expect(rows).toHaveLength(links.length + 1);
    expect(rows[0]).toMatchObject({ url: `${o}/`, sourceDocument: null, detail: { kind: "seed" } });
  });

  it("obeys robots.txt and scope, and fetches each document at most once", async () => {
    const reqs = discoveryRequests();
    expect(reqs.filter((p) => /^\/(private|tmp)\/|^\/index\.xml$/.test(p))).toEqual([]);
    const counts = reqs.reduce<Record<string, number>>(
      (a, p) => ({ ...a, [p]: (a[p] ?? 0) + 1 }),
      {},
    );
    expect(Object.entries(counts).filter(([, n]) => n > 1)).toEqual([]);
    const fetches = (await q.listFetches(db, runId)).filter((f) => f.purpose === "discovery");
    expect(fetches.find((f) => f.requestedUrl === `${o}/index.xml`)?.error).toMatch(
      /blocked by robots\.txt/,
    );
    expect(fetches.find((f) => f.requestedUrl.includes("fixture.invalid"))?.error).toBe(
      "discovery: outside the crawl scope, not fetched",
    );
  });

  it("respects the per-host rate limit during discovery", () => {
    const disc = env.dispatches.slice(crawlDispatches);
    expect(disc.length).toBeGreaterThan(10);
    const gaps = disc.slice(1).map((x, i) => x.at - (disc[i]?.at ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(19);
  });

  it("counts discovery requests separately from the crawl", async () => {
    const fetches = await q.listFetches(db, runId);
    const discovery = fetches.filter((f) => f.purpose === "discovery" && f.statusCode !== null);
    expect(summary.fetches).toBe(discovery.length);
    expect(summary.capReached).toBe(false);
    expect(
      new Set(fetches.filter((f) => f.purpose === "crawl").map((f) => f.requestedUrl)).size,
    ).toBe(32);
  });

  describe("reconciliation", () => {
    let rec: d.PersistedReconciliation;
    const entry = (path: string) => rec.inventory.find((e) => e.node === o + path);

    beforeAll(async () => {
      rec = await d.reconcileDiscovery(db, runId, "P0");
    });

    it("finds exactly one orphan per non-link channel", () => {
      expect(rec.orphans.map((n) => n.replace(o, "")).sort()).toEqual([
        "/html-only.html",
        "/llms-orphan.html",
        "/orphan.html",
        "/rss-orphan.html",
        "/sitemap-orphan.html",
      ]);
      expect(entry("/rss-orphan.html")).toMatchObject({
        channels: ["feed"],
        reachable: false,
        orphan: true,
      });
      expect(entry("/sitemap-orphan.html")?.channels).toEqual(["robots_sitemap"]);
      expect(entry("/orphan.html")?.channels).toEqual(["xml_sitemap"]);
    });

    it("records every channel that found a URL", () => {
      expect(entry("/about.html")).toMatchObject({
        channels: ["link_graph", "xml_sitemap", "robots_sitemap", "html_sitemap", "llms_txt"],
        reachable: true,
        depth: 1,
        orphan: false,
      });
      expect(entry("/blog/post-2.html")?.channels).toEqual([
        "link_graph",
        "robots_sitemap",
        "feed",
      ]);
    });

    it("computes each channel's marginal yield", () => {
      expect(rec.channels.xml_sitemap).toEqual({ total: 4, exclusive: 1, orphans: 1 });
      expect(rec.channels.robots_sitemap).toEqual({ total: 5, exclusive: 1, orphans: 1 });
      expect(rec.channels.html_sitemap).toMatchObject({ exclusive: 1, orphans: 1 });
      expect(rec.channels.feed).toEqual({ total: 3, exclusive: 1, orphans: 1 });
      expect(rec.channels.llms_txt).toEqual({ total: 3, exclusive: 1, orphans: 1 });
      expect(rec.channels.link_graph.exclusive).toBeGreaterThan(10);
      expect(rec.channels.link_graph.orphans).toBe(0);
      // Two robots.txt fetches (crawl + discovery), each recording its two Sitemap: lines.
      expect(rec.skipped.directives).toBe(4);
    });

    it("persists an artefact tagged with run id and policy version", async () => {
      expect(rec.artefact).toMatchObject({
        runId,
        policyVersion: "P0@1.0.0",
        kind: "discovery-reconciliation",
      });
      const stored = await q.listArtefacts(db, runId, { kind: "discovery-reconciliation" });
      expect((stored[0]?.payload as { orphans: string[] }).orphans).toEqual(rec.orphans);
    });

    it("works under a coarser policy (P3 nodes)", async () => {
      const p3 = await d.reconcileDiscovery(db, runId, "P3");
      const https = o.replace("http://", "https://");
      expect(p3.policyVersion).toBe("P3@1.0.0");
      expect(p3.orphans.map((n) => n.replace(https, "")).sort()).toEqual([
        "/html-only.html",
        "/llms-orphan.html",
        "/orphan.html",
        "/rss-orphan.html",
        "/sitemap-orphan.html",
      ]);
      expect(p3.inventory.length).toBeLessThan(rec.inventory.length); // e.g. ?ref=nav merged
    });
  });
});

describe("discovery caps", () => {
  let env: Awaited<ReturnType<typeof environment>>;
  afterEach(() => env.close());

  it("is not limited by pageCap, and stops at its own discoveryMaxFetches", async () => {
    env = await environment();
    const o = env.server.origin;
    const crawl = await env.orchestrator.crawl(`${o}/`, { config: { ...BASE_CONFIG, pageCap: 3 } });
    const crawlFetches = (await q.listFetches(db, crawl.runId)).filter(
      (f) => f.purpose === "crawl",
    );
    expect(new Set(crawlFetches.map((f) => f.requestedUrl)).size).toBe(3);

    const unlimited = env.discovery();
    try {
      const s = await unlimited.run(crawl.runId);
      expect(s.fetches).toBeGreaterThan(3); // discovery documents beyond the 3-page crawl cap
      expect(s.capReached).toBe(false);
    } finally {
      await unlimited.close();
    }

    const capped = env.discovery({ discoveryMaxFetches: 2 });
    try {
      const again = await env.orchestrator.crawl(`${o}/`, {
        config: { ...BASE_CONFIG, pageCap: 3 },
      });
      const before = env.server.requests.length;
      const s = await capped.run(again.runId);
      expect(s).toMatchObject({ fetches: 2, capReached: true });
      const sent = env.server.requests.slice(before).filter((r) => r.path !== "/robots.txt");
      expect(sent).toHaveLength(2);
    } finally {
      await capped.close();
    }
  });
});
