import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Redis } from "ioredis";
import type pg from "pg";
import { db as q, makeConfig, type LinkLensConfig } from "@linklens/core";
import { asQueryable, createPool } from "@linklens/db";
import { CrawlOrchestrator, type CrawlProgress } from "../src/orchestrator.js";
import { PNG, SITE_DIR, startFixtureServer, type FixtureServer } from "./fixtures/server.js";

const UA = "LinkLensBot/0.1 (+https://linklens.test/bot)";
const BASE_CONFIG: Partial<LinkLensConfig> = {
  userAgent: UA,
  crawlDelayMs: 0, // robots.txt Crawl-delay (20 ms) governs
  fetchTimeoutMs: 300,
  retryBackoffMs: 50,
  maxRedirects: 3,
};
const TOTAL_URLS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

let pool: pg.Pool;
let db: q.Queryable;
let redis: Redis;
let prefix: string;
let orchestrator: CrawlOrchestrator;
let server: FixtureServer;
/** When each request was dispatched by the crawler (server arrival times include network jitter). */
let dispatches: { url: string; at: number }[] = [];

const recordingFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  dispatches.push({ url, at: performance.now() });
  return fetch(input, init);
};

const newOrchestrator = () =>
  new CrawlOrchestrator({ pool, redisUrl: inject("redisUrl"), prefix, fetch: recordingFetch });

beforeAll(() => {
  pool = createPool(inject("databaseUrl"));
  db = asQueryable(pool);
  redis = new Redis(inject("redisUrl"));
});
afterAll(async () => {
  await pool.end();
  await redis.quit();
});
/** Fresh fixture server (its /flaky counter resets), orchestrator and Redis prefix. */
async function setupEnv(serverOpts: Parameters<typeof startFixtureServer>[0] = {}): Promise<void> {
  prefix = `linklens_test_${randomBytes(4).toString("hex")}`;
  dispatches = [];
  orchestrator = newOrchestrator();
  server = await startFixtureServer(serverOpts);
}
async function teardownEnv(): Promise<void> {
  await orchestrator.close();
  await server.close();
  const leftovers = await redis.keys(`${prefix}*`);
  if (leftovers.length > 0) await redis.del(...leftovers);
}
/** Redis keys a run leaves behind, ignoring the shared, self-expiring per-host throttle keys. */
const runKeys = async () =>
  (await redis.keys(`${prefix}*`)).filter((k) => !k.includes(":throttle:"));

const crawlFetches = (fetches: q.FetchRow[]) =>
  fetches.filter((f) => !f.requestedUrl.endsWith("/robots.txt"));
const count = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {});
const minGap = (ds: { at: number }[]) =>
  Math.min(...ds.slice(1).map((d, i) => d.at - (ds[i]?.at ?? 0)));

const ALL_PATHS = [
  "/",
  "/about.html",
  "/about.html?ref=nav", // query not stripped
  "/About.html", // case not folded
  "/blog/",
  "/blog", // trailing slash not added
  "/deep/1.html",
  "/deep/2.html",
  "/deep/3.html",
  "/deep/4.html",
  "/deep/5.html",
  "/deep/6.html",
  "/old-page",
  "/chain-a",
  "/loop-a",
  "/to-external",
  "/to-private",
  "/private/secret.html",
  "/private/public-note.html",
  "/tmp/x.html",
  "/missing.html",
  "/image.png",
  "/files/report.pdf",
  "/flaky",
  "/always-500",
  "/slow",
  "/nofollow-target.html",
  "/blog/post-1.html",
  "/blog/post-2.html",
  "/nofollow-page.html",
  "/only-from-nofollow-page.html",
];

describe("full crawl of the fixture site", () => {
  let runId: number;
  let progress: CrawlProgress[];
  let fetches: q.FetchRow[];
  let byUrl: (path: string) => q.FetchRow[];
  let o: string;

  // One crawl, many assertions.
  afterAll(teardownEnv);
  beforeAll(async () => {
    await setupEnv();
    o = server.origin;
    const created = await orchestrator.createRun(`${o}/`, { config: BASE_CONFIG });
    runId = created.runId;
    const handle = await orchestrator.start(runId);
    progress = [];
    handle.on("progress", (p) => progress.push(p));
    const summary = await handle.done;
    expect(summary).toMatchObject({
      runId,
      status: "completed",
      pagesFetched: TOTAL_URLS,
      admitted: TOTAL_URLS,
    });
    fetches = await q.listFetches(db, runId);
    byUrl = (path) => fetches.filter((f) => f.requestedUrl === o + path);
  });

  it("marks the run completed and stores the effective config", async () => {
    const run = await q.getRun(db, runId);
    expect(run?.status).toBe("completed");
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(run?.config).toMatchObject({ userAgent: UA, maxRedirects: 3, pageCap: 500 });
  });

  it("fetches robots.txt first and sends the configured User-Agent on every request", () => {
    expect(server.requests[0]?.path).toBe("/robots.txt");
    expect(new Set(server.requests.map((r) => r.userAgent))).toEqual(new Set([UA]));
    expect(fetches[0]).toMatchObject({ requestedUrl: `${o}/robots.txt`, statusCode: 200 });
  });

  it("records robots.txt Sitemap directives raw as a discovery channel", async () => {
    const obs = await q.listDiscoveryObservations(db, runId, "robots_sitemap");
    expect(obs.map((d) => d.url)).toEqual([
      "/sitemap.xml",
      "https://fixture.invalid/other-sitemap.xml",
    ]);
    expect(obs[0]?.sourceDocument).toBe(`${o}/robots.txt`);
  });

  it("crawls exactly the linked in-scope URLs, deduped by string only", () => {
    expect(new Set(crawlFetches(fetches).map((f) => f.requestedUrl))).toEqual(
      new Set(ALL_PATHS.map((p) => o + p)),
    );
  });

  it("never finds the orphan or leaves the site", () => {
    const paths = server.requests.map((r) => r.path);
    expect(paths).not.toContain("/orphan.html");
    expect(paths).not.toContain("/sitemap.xml");
    expect(fetches.some((f) => f.requestedUrl.includes("external.invalid"))).toBe(false);
  });

  it("checks robots.txt before every request, including redirect hops", () => {
    const paths = server.requests.map((r) => r.path);
    expect(paths).not.toContain("/private/secret.html");
    expect(paths).not.toContain("/tmp/x.html");
    expect(paths).toContain("/private/public-note.html"); // longer Allow wins

    expect(byUrl("/private/secret.html")).toEqual([
      expect.objectContaining({
        statusCode: null,
        finalUrl: null,
        error: expect.stringMatching(
          /blocked by robots\.txt.*disallow \/private\/ \(robots\.txt line 6\)/,
        ),
      }),
    ]);
    const toPrivate = byUrl("/to-private")[0];
    expect(toPrivate).toMatchObject({
      statusCode: 301,
      finalUrl: `${o}/to-private`,
      redirectChain: [
        { url: `${o}/to-private`, statusCode: 301, location: "/private/secret.html" },
      ],
    });
    expect(toPrivate?.error).toMatch(/blocked by robots\.txt/);
  });

  it("follows redirects manually and records the full chain", () => {
    expect(byUrl("/chain-a")).toEqual([
      expect.objectContaining({
        statusCode: 200,
        finalUrl: `${o}/about.html`,
        redirectChain: [
          { url: `${o}/chain-a`, statusCode: 302, location: "/chain-b" },
          { url: `${o}/chain-b`, statusCode: 301, location: "/about.html" },
        ],
        error: null,
      }),
    ]);
    expect(byUrl("/old-page")[0]).toMatchObject({ statusCode: 200, finalUrl: `${o}/moved.html` });
  });

  it("stops at maxRedirects and on off-site redirects", () => {
    const loop = byUrl("/loop-a")[0];
    expect(loop?.redirectChain).toHaveLength(4);
    expect(loop?.error).toBe("more than 3 redirects");
    expect(byUrl("/to-external")[0]).toMatchObject({
      statusCode: 301,
      error: "redirect leaves crawl scope: https://external.invalid/",
    });
  });

  it("stores status, headers, content-type and bytes; skips non-HTML but records it", async () => {
    const png = byUrl("/image.png")[0];
    expect(png).toMatchObject({ statusCode: 200, contentType: "image/png", bytes: PNG.length });
    expect(png?.headers["content-length"]).toBe(String(PNG.length));
    expect(byUrl("/files/report.pdf")[0]).toMatchObject({
      statusCode: 200,
      contentType: "application/pdf",
    });
    expect(byUrl("/missing.html")).toEqual([expect.objectContaining({ statusCode: 404 })]);
    expect(byUrl("/About.html")).toEqual([expect.objectContaining({ statusCode: 404 })]);

    const pages = await q.listPages(db, runId);
    const pageUrls = pages.map((p) => p.url);
    expect(pageUrls).not.toContain(`${o}/image.png`);
    expect(pageUrls).not.toContain(`${o}/files/report.pdf`);
    expect(pageUrls).not.toContain(`${o}/missing.html`);
  });

  it("stores raw HTML bytes exactly as served, and none for non-HTML", async () => {
    const home = byUrl("/")[0];
    const body = await q.getFetchBody(db, home?.id ?? -1);
    const onDisk = readFileSync(join(SITE_DIR, "index.html"));
    expect(Buffer.from(body?.body ?? [])).toEqual(onDisk);
    expect(body).toMatchObject({
      truncated: false,
      sha256: createHash("sha256").update(onDisk).digest("hex"),
    });
    expect(await q.getFetchBody(db, byUrl("/image.png")[0]?.id ?? -1)).toBeNull();
    expect(await q.getFetchBody(db, byUrl("/missing.html")[0]?.id ?? -1)).toBeNull();
  });

  it("stores one page per crawled HTML document, keeping canonical/robots tags raw", async () => {
    const pages = await q.listPages(db, runId);
    expect(pages).toHaveLength(18);
    expect(count(pages, (p) => p.url)[`${o}/about.html`]).toBe(1); // chain-a's target not re-extracted
    expect(pages.find((p) => p.url === `${o}/moved.html`)).toBeDefined();

    const tracked = pages.find((p) => p.url === `${o}/about.html?ref=nav`);
    expect(tracked).toMatchObject({ title: "About", metaCanonical: "/about.html" });
    const post2 = pages.find((p) => p.url === `${o}/blog/post-2.html`);
    expect(post2).toMatchObject({
      metaCanonical: "/blog/post-1.html",
      metaRobots: "noindex, follow",
    });
    const home = pages.find((p) => p.url === `${o}/`);
    expect(home).toMatchObject({
      title: "Fixture Home",
      h1: "Welcome",
      lang: "en",
      metaCanonical: "/",
    });
    expect(home?.headings).toEqual([
      { level: 1, text: "Welcome" },
      { level: 2, text: "Sections" },
    ]);
  });

  it("stores every link observation raw, in document order, with a template signature", async () => {
    const home = fetches.find((f) => f.requestedUrl === `${o}/` && f.statusCode === 200);
    const links = (await q.listLinkObservations(db, runId)).filter(
      (l) => l.sourceFetchId === home?.id,
    );
    expect(links).toHaveLength(28);
    expect(links.map((l) => l.positionIndex)).toEqual([...Array(28).keys()]);
    expect(links[2]).toMatchObject({
      rawHref: "./about.html#team",
      resolvedUrl: `${o}/about.html#team`,
      anchorText: "Team",
      domRegion: "nav",
      domPath: "html>body>header>nav>ul>li:nth-of-type(3)>a",
      templateSignature: "nav|html>body>header>nav>ul>li>a",
    });
    expect(links.find((l) => l.rawHref === "/image.png")?.anchorText).toBe("Logo");
    expect(links.find((l) => l.rawHref === "http://[bad")?.resolvedUrl).toBeNull();
    expect(links.find((l) => l.rawHref === "mailto:hi@example.com")?.domRegion).toBe("footer");
    expect(links.find((l) => l.rawHref === "/nofollow-target.html")?.rel).toBe("nofollow");
  });

  it("follows nofollow links by default (followNofollow = true)", () => {
    const paths = server.requests.map((r) => r.path);
    expect(paths).toContain("/nofollow-target.html");
    expect(paths).toContain("/only-from-nofollow-page.html");
  });

  it("retries 5xx and network errors at most twice, numbering every attempt", () => {
    expect(byUrl("/flaky").map((f) => [f.attempt, f.statusCode])).toEqual([
      [1, 503],
      [2, 200],
    ]);
    expect(byUrl("/always-500").map((f) => [f.attempt, f.statusCode])).toEqual([
      [1, 500],
      [2, 500],
      [3, 500],
    ]);
    const slow = byUrl("/slow");
    expect(slow.map((f) => f.attempt)).toEqual([1, 2, 3]);
    for (const f of slow) {
      expect(f.statusCode).toBeNull();
      expect(f.error).toMatch(/timeout/i);
    }
    expect(byUrl("/missing.html")).toHaveLength(1); // 4xx is not retried
  });

  it("exposes one final fetch per URL", async () => {
    const final = await q.listFinalFetches(db, runId);
    expect(final).toHaveLength(TOTAL_URLS + 1); // + robots.txt
    expect(final.find((f) => f.requestedUrl === `${o}/flaky`)).toMatchObject({
      attempt: 2,
      statusCode: 200,
    });
  });

  it("crawls breadth-first", () => {
    const retried = new Set(["/flaky", "/always-500", "/slow"].map((p) => o + p));
    const depths = progress.filter((p) => !retried.has(p.url)).map((p) => p.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(progress.find((p) => p.url === `${o}/deep/6.html`)?.depth).toBe(6);
  });

  it("emits progress with pages fetched and queue size", () => {
    expect(progress.map((p) => p.pagesFetched)).toEqual(
      [...Array(TOTAL_URLS).keys()].map((i) => i + 1),
    );
    expect(progress[0]).toMatchObject({ url: `${o}/`, depth: 0, statusCode: 200 });
    expect(progress[0]?.queueSize).toBeGreaterThan(15);
    expect(progress.at(-1)?.queueSize).toBe(0);
    expect(progress.every((p) => p.runId === runId && p.admitted <= TOTAL_URLS)).toBe(true);
  });

  it("keeps every dispatch to the host at least the Crawl-delay (20 ms) apart", () => {
    expect(dispatches.length).toBe(server.requests.length);
    expect(minGap(dispatches)).toBeGreaterThanOrEqual(19);
  });

  it("cleans up its queue and frontier keys; the throttle key expires on its own", async () => {
    expect(await runKeys()).toEqual([]);
    for (const key of await redis.keys(`${prefix}*`)) {
      expect(await redis.pttl(key)).toBeGreaterThan(0);
    }
  });
});

describe("isolated runs", () => {
  afterEach(teardownEnv);

  describe("page cap", () => {
    beforeEach(() => setupEnv());

    it("admits at most pageCap URLs, in BFS/document order", async () => {
      const o = server.origin;
      const summary = await orchestrator.crawl(`${o}/`, { config: { ...BASE_CONFIG, pageCap: 6 } });
      expect(summary).toMatchObject({ status: "completed", admitted: 6, pagesFetched: 6 });
      const fetched = crawlFetches(await q.listFetches(db, summary.runId)).map(
        (f) => f.requestedUrl,
      );
      expect(fetched).toEqual(
        ["/", "/about.html", "/about.html?ref=nav", "/About.html", "/blog/", "/blog"].map(
          (p) => o + p,
        ),
      );
    });
  });

  describe("site root handling", () => {
    beforeEach(() => setupEnv());

    it("reuses the site row for an identical root_url and rejects a non-identifying UA", async () => {
      const o = server.origin;
      const a = await orchestrator.createRun(`${o}/`, { config: { ...BASE_CONFIG, pageCap: 1 } });
      const b = await orchestrator.createRun(`${o}/`, { config: { ...BASE_CONFIG, pageCap: 1 } });
      expect(b.siteId).toBe(a.siteId);
      expect(b.runId).not.toBe(a.runId);
      await expect(
        orchestrator.createRun(`${o}/`, {
          config: { userAgent: "LinkLensBot/0.1 (+contact URL)" },
        }),
      ).rejects.toThrow(/not identifying/);
      await (
        await orchestrator.start(a.runId)
      ).done;
      await (
        await orchestrator.start(b.runId)
      ).done;
    });
  });

  describe("nofollow", () => {
    beforeEach(() => setupEnv());

    it("with followNofollow = false, records nofollow links but does not enqueue them", async () => {
      const o = server.origin;
      const summary = await orchestrator.crawl(`${o}/`, {
        config: { ...BASE_CONFIG, followNofollow: false },
      });
      expect(summary.admitted).toBe(TOTAL_URLS - 2);
      const paths = server.requests.map((r) => r.path);
      expect(paths).not.toContain("/nofollow-target.html"); // rel="nofollow"
      expect(paths).toContain("/nofollow-page.html"); // linked normally
      expect(paths).not.toContain("/only-from-nofollow-page.html"); // meta robots nofollow
      const links = await q.listLinkObservations(db, summary.runId);
      expect(links.some((l) => l.rawHref === "/nofollow-target.html")).toBe(true);
      expect(links.some((l) => l.rawHref === "/only-from-nofollow-page.html")).toBe(true);
    });
  });

  describe("Crawl-delay cap", () => {
    beforeEach(() => setupEnv());

    it("does not crawl a host whose Crawl-delay exceeds maxCrawlDelayMs", async () => {
      const o = server.origin;
      const summary = await orchestrator.crawl(`${o}/`, {
        config: { ...BASE_CONFIG, maxCrawlDelayMs: 10 },
      });
      expect(summary).toMatchObject({ status: "completed", pagesFetched: 1 });
      expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt"]);
      const [seed] = crawlFetches(await q.listFetches(db, summary.runId));
      expect(seed?.error).toBe(
        "host not crawled: robots.txt Crawl-delay 20 ms exceeds maxCrawlDelayMs 10",
      );
    });
  });

  describe("robots.txt availability", () => {
    const cap = { ...BASE_CONFIG, pageCap: 13 }; // the 13th admitted URL is /private/secret.html

    it("5xx: disallows everything", async () => {
      await setupEnv({ robotsStatus: 503 });
      const summary = await orchestrator.crawl(`${server.origin}/`, { config: cap });
      expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt"]);
      const [seed] = crawlFetches(await q.listFetches(db, summary.runId));
      expect(seed?.error).toMatch(/robots\.txt unreachable/);
    });

    it("5xx for ≥ robotsUnreachableGraceDays (per earlier runs): allows everything", async () => {
      await setupEnv({ robotsStatus: 503 });
      const o = server.origin;
      const site = await q.insertSite(db, { rootUrl: `${o}/history` });
      const old = await q.createRun(db, { siteId: site.id, config: makeConfig() });
      await q.insertFetch(db, {
        runId: old.id,
        requestedUrl: `${o}/robots.txt`,
        statusCode: 503,
        fetchedAt: new Date(Date.now() - 31 * DAY_MS),
      });
      await orchestrator.crawl(`${o}/`, { config: cap });
      expect(server.requests.map((r) => r.path)).toContain("/private/secret.html");
    });

    it("429: allow all by default (RFC 9309), disallow all with robotsTreat429AsUnreachable", async () => {
      await setupEnv({ robotsStatus: 429 });
      await orchestrator.crawl(`${server.origin}/`, { config: cap });
      expect(server.requests.map((r) => r.path)).toContain("/private/secret.html");

      server.requests.length = 0;
      await orchestrator.crawl(`${server.origin}/`, {
        config: { ...cap, robotsTreat429AsUnreachable: true },
      });
      expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt"]);
    });

    it("refetches robots.txt once the cached copy is older than robotsCacheTtlMs", async () => {
      await setupEnv();
      const summary = await orchestrator.crawl(`${server.origin}/`, {
        config: { ...BASE_CONFIG, pageCap: 4, robotsCacheTtlMs: 1 },
      });
      const robots = (await q.listFetches(db, summary.runId)).filter((f) =>
        f.requestedUrl.endsWith("/robots.txt"),
      );
      expect(robots.length).toBeGreaterThan(1);
    });
  });

  describe("detach and resume", () => {
    beforeEach(() => setupEnv());

    it("a detached run keeps its Redis state and resumes where it stopped", async () => {
      const o = server.origin;
      const { runId } = await orchestrator.createRun(`${o}/`, { config: BASE_CONFIG });
      const first = await orchestrator.start(runId);
      await new Promise<void>((resolve) =>
        first.on("progress", (p) => {
          if (p.pagesFetched === 5) resolve();
        }),
      );
      const detached = await first.detach();
      expect(detached.status).toBe("detached");
      expect((await q.getRun(db, runId))?.status).toBe("running");
      expect((await runKeys()).length).toBeGreaterThan(0);

      const second = newOrchestrator();
      try {
        const handle = await second.resume(runId);
        const progress: CrawlProgress[] = [];
        handle.on("progress", (p) => progress.push(p));
        const summary = await handle.done;
        expect(summary).toMatchObject({
          status: "completed",
          pagesFetched: TOTAL_URLS,
          admitted: TOTAL_URLS,
        });
        expect(progress.at(-1)?.pagesFetched).toBe(TOTAL_URLS); // counter carried over
      } finally {
        await second.close();
      }

      const fetches = crawlFetches(await q.listFetches(db, runId));
      expect(new Set(fetches.map((f) => f.requestedUrl))).toEqual(
        new Set(ALL_PATHS.map((p) => o + p)),
      );
      const retried = new Set(["/flaky", "/always-500", "/slow"].map((p) => o + p));
      const perUrl = count(
        fetches.filter((f) => !retried.has(f.requestedUrl)),
        (f) => f.requestedUrl,
      );
      expect(Math.max(...Object.values(perUrl))).toBe(1); // nothing fetched twice
      expect((await q.getRun(db, runId))?.status).toBe("completed");
    });

    it("marks a running run failed when its Redis state is gone", async () => {
      const site = await q.insertSite(db, { rootUrl: `${server.origin}/lost` });
      const run = await q.createRun(db, { siteId: site.id, config: makeConfig(BASE_CONFIG) });
      await q.setRunStatus(db, run.id, "running");
      const handle = await orchestrator.resume(run.id);
      await expect(handle.done).resolves.toMatchObject({
        status: "failed",
        error: "frontier state missing in Redis; the run cannot be resumed",
      });
      expect((await q.getRun(db, run.id))?.status).toBe("failed");
    });

    it("refuses to resume a run that is not running", async () => {
      const { runId } = await orchestrator.createRun(`${server.origin}/`, {
        config: { ...BASE_CONFIG, pageCap: 1 },
      });
      await expect(orchestrator.resume(runId)).rejects.toThrow(/expected running/);
      await (
        await orchestrator.start(runId)
      ).done;
    });
  });

  describe("politeness across processes", () => {
    beforeEach(() => setupEnv());

    it("two orchestrators crawling one host share the per-host throttle", async () => {
      const o = server.origin;
      const other = newOrchestrator();
      try {
        // Until robots.txt is read only config.crawlDelayMs (5 ms) is known; after that, 20 ms.
        const config = { ...BASE_CONFIG, crawlDelayMs: 5, pageCap: 8 };
        const [a, b] = await Promise.all([
          orchestrator.createRun(`${o}/`, { config }),
          other.createRun(`${o}/`, { config }),
        ]);
        const handles = await Promise.all([orchestrator.start(a.runId), other.start(b.runId)]);
        await Promise.all(handles.map((h) => h.done));
      } finally {
        await other.close();
      }
      expect(dispatches.length).toBeGreaterThan(16);
      expect(minGap(dispatches)).toBeGreaterThanOrEqual(4.5); // both robots.txt requests
      expect(minGap(dispatches.slice(1))).toBeGreaterThanOrEqual(19); // every later gap
    });
  });

  describe("cancellation", () => {
    beforeEach(() => setupEnv());

    it("stops gracefully, marks the run cancelled and leaves nothing queued", async () => {
      const o = server.origin;
      const { runId } = await orchestrator.createRun(`${o}/`, {
        config: { ...BASE_CONFIG, crawlDelayMs: 300 },
      });
      const handle = await orchestrator.start(runId);
      await new Promise<void>((resolve) => handle.once("progress", () => resolve()));

      const summary = await orchestrator.cancel(runId);
      expect(summary.status).toBe("cancelled");
      expect(summary.pagesFetched).toBeLessThan(5);
      expect((await q.getRun(db, runId))?.status).toBe("cancelled");

      const seen = server.requests.length;
      await new Promise((r) => setTimeout(r, 800));
      expect(server.requests.length).toBe(seen); // no requests after cancel resolved
      expect(await runKeys()).toEqual([]);
      await expect(handle.done).resolves.toMatchObject({ status: "cancelled" });
    });
  });
});
