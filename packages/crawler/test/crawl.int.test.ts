import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Redis } from "ioredis";
import type pg from "pg";
import { db as q, type LinkLensConfig } from "@linklens/core";
import { asQueryable, createPool } from "@linklens/db";
import { CrawlOrchestrator, type CrawlProgress } from "../src/orchestrator.js";
import { PNG, startFixtureServer, type FixtureServer } from "./fixtures/server.js";

const UA = "LinkLensBot/0.1 (+https://linklens.test/bot)";
const BASE_CONFIG: Partial<LinkLensConfig> = {
  userAgent: UA,
  crawlDelayMs: 0, // robots.txt Crawl-delay (20 ms) governs
  fetchTimeoutMs: 300,
  retryBackoffMs: 50,
  maxRedirects: 3,
};

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
async function setupEnv(): Promise<void> {
  prefix = `linklens_test_${randomBytes(4).toString("hex")}`;
  dispatches = [];
  orchestrator = new CrawlOrchestrator({
    pool,
    redisUrl: inject("redisUrl"),
    prefix,
    fetch: recordingFetch,
  });
  server = await startFixtureServer();
}
async function teardownEnv(): Promise<void> {
  await orchestrator.close();
  await server.close();
  const leftovers = await redis.keys(`${prefix}*`);
  if (leftovers.length > 0) await redis.del(...leftovers);
}

const crawlFetches = (fetches: q.FetchRow[]) =>
  fetches.filter((f) => !f.requestedUrl.endsWith("/robots.txt"));
const count = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {});

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
    expect(summary).toMatchObject({ runId, status: "completed", pagesFetched: 28, admitted: 28 });
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
    const expected = [
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
      "/blog/post-1.html",
      "/blog/post-2.html",
    ].map((p) => o + p);
    expect(new Set(crawlFetches(fetches).map((f) => f.requestedUrl))).toEqual(new Set(expected));
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

  it("stores one page per crawled HTML document, keeping canonical/robots tags raw", async () => {
    const pages = await q.listPages(db, runId);
    expect(pages).toHaveLength(15);
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

  it("stores every link observation raw, in document order", async () => {
    const home = fetches.find((f) => f.requestedUrl === `${o}/` && f.statusCode === 200);
    const links = (await q.listLinkObservations(db, runId)).filter(
      (l) => l.sourceFetchId === home?.id,
    );
    expect(links).toHaveLength(27);
    expect(links.map((l) => l.positionIndex)).toEqual([...Array(27).keys()]);
    expect(links[2]).toMatchObject({
      rawHref: "./about.html#team",
      resolvedUrl: `${o}/about.html#team`,
      anchorText: "Team",
      domRegion: "nav",
    });
    expect(links.find((l) => l.rawHref === "/image.png")?.anchorText).toBe("Logo");
    expect(links.find((l) => l.rawHref === "http://[bad")?.resolvedUrl).toBeNull();
    expect(links.find((l) => l.rawHref === "mailto:hi@example.com")?.domRegion).toBe("footer");
  });

  it("retries 5xx and network errors at most twice, with every attempt recorded", () => {
    expect(byUrl("/flaky").map((f) => f.statusCode)).toEqual([503, 200]);
    expect(byUrl("/always-500").map((f) => f.statusCode)).toEqual([500, 500, 500]);
    const slow = byUrl("/slow");
    expect(slow).toHaveLength(3);
    for (const f of slow) {
      expect(f.statusCode).toBeNull();
      expect(f.error).toMatch(/timeout/i);
    }
    expect(byUrl("/missing.html")).toHaveLength(1); // 4xx is not retried
  });

  it("crawls breadth-first", () => {
    const retried = new Set(["/flaky", "/always-500", "/slow"].map((p) => o + p));
    const depths = progress.filter((p) => !retried.has(p.url)).map((p) => p.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(progress.find((p) => p.url === `${o}/deep/6.html`)?.depth).toBe(6);
  });

  it("emits progress with pages fetched and queue size", () => {
    expect(progress.map((p) => p.pagesFetched)).toEqual([...Array(28).keys()].map((i) => i + 1));
    expect(progress[0]).toMatchObject({ url: `${o}/`, depth: 0, statusCode: 200 });
    expect(progress[0]?.queueSize).toBeGreaterThan(15);
    expect(progress.at(-1)?.queueSize).toBe(0);
    expect(progress.every((p) => p.runId === runId && p.admitted <= 28)).toBe(true);
  });

  it("respects the per-host token bucket (robots Crawl-delay 20 ms)", () => {
    // Every gap, including robots.txt → seed (the delay is learned from robots.txt itself).
    const sent = dispatches;
    expect(sent.length).toBe(server.requests.length);
    const tooClose = sent
      .slice(1)
      .map((r, i) => ({ from: sent[i]?.url, to: r.url, gap: r.at - (sent[i]?.at ?? 0) }))
      .filter((g) => g.gap < 19);
    expect(tooClose).toEqual([]);
  });

  it("cleans up its queue and frontier keys in Redis", async () => {
    expect(await redis.keys(`${prefix}*`)).toEqual([]);
  });
});

describe("isolated runs", () => {
  beforeEach(setupEnv);
  afterEach(teardownEnv);

  describe("page cap", () => {
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

  describe("cancellation", () => {
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
      expect(await redis.keys(`${prefix}*`)).toEqual([]);
      await expect(handle.done).resolves.toMatchObject({ status: "cancelled" });
    });
  });
});
