import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { Redis } from "ioredis";
import type pg from "pg";
import {
  audit as a,
  db as q,
  diagnosis as dg,
  discovery as d,
  fixes as fx,
  graph as gr,
  prominence as pr,
  semantic as sem,
  text as t,
  type LinkLensConfig,
} from "@linklens/core";
import { asQueryable, createPool } from "@linklens/db";
import { buildRescueRun } from "@linklens/counterfactual";
import { DiscoveryRunner, type DiscoverySummary } from "../src/discovery/runner.js";
import { RescueFetcher } from "../src/rescue.js";
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
  const rescue = () =>
    new RescueFetcher({ pool, redisUrl: inject("redisUrl"), prefix, fetch: recordingFetch });
  return {
    server,
    orchestrator,
    discovery,
    rescue,
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

    it("feeds the structural audit (issues + summary artefact)", async () => {
      const audit = await a.auditRun(db, runId, "P0");
      const nodes = (type: string, rule?: string) =>
        audit.issues
          .filter((i) => i.type === type && (rule === undefined || i.rule === rule))
          .map((i) => i.node.replace(o, ""))
          .sort();
      expect(nodes("orphan")).toEqual(rec.orphans.map((n) => n.replace(o, "")).sort());
      expect(nodes("deep-page")).toEqual(["/deep/4.html", "/deep/5.html", "/deep/6.html"]);
      expect(nodes("noindex-nofollow-conflict", "noindex-in-sitemap")).toEqual([
        "/blog/post-2.html",
      ]);
      expect(nodes("noindex-nofollow-conflict", "nofollow-sole-path")).toEqual([
        "/nofollow-page.html",
      ]);
      expect(nodes("noindex-nofollow-conflict", "internal-nofollow")).toEqual([
        "/nofollow-target.html",
      ]);
      expect(audit.summary).toMatchObject({
        runId,
        policyVersion: "P0@1.0.0",
        total: audit.issues.length,
      });
      expect(audit.artefact).toMatchObject({
        runId,
        policyVersion: "P0@1.0.0",
        kind: "structural-audit",
      });
    });

    it("builds the text representation from stored fields and regions", async () => {
      const model = await t.buildTextRun(db, runId, "P0");
      expect(model.artefact).toMatchObject({
        runId,
        policyVersion: "P0@1.0.0",
        kind: "text-representation",
      });
      const pages = await q.listPages(db, runId);
      expect(model.documents).toHaveLength(new Set(pages.map((p) => p.url)).size);
      const byPath = (path: string) => {
        const found = model.documents.find((x) => x.node === o + path);
        if (found === undefined) throw new Error(`no text document for ${path}`);
        return found;
      };
      const terms = (x: t.TextDocument) => t.FIELDS.flatMap((f) => Object.keys(x.fields[f]));

      const home = byPath("/");
      expect(home.fields.links).toHaveProperty("deep chain");
      expect(home.donor).toContain("deep chain");
      // "Team" is only in <nav>, "External" only in <footer>: in no field.
      expect(terms(home)).not.toContain("team");
      expect(terms(home)).not.toContain("extern");

      const post = byPath("/blog/post-1.html");
      expect(post.fields.links).toHaveProperty("author");
      expect(post.fields.links).toHaveProperty("back blog");
      // "Home" is only in the breadcrumb, header nav and footer nav.
      expect(terms(post)).not.toContain("home");

      const stored = await q.listArtefacts(db, runId, { kind: "text-representation" });
      expect((stored[0]?.payload as unknown as t.TextModel).stats).toEqual(model.stats);
    });

    it("computes the REF matrix from the run's text representation", async () => {
      const text = await t.loadTextModel(db, runId, "P0");
      for (const variant of ["weighted", "unweighted"] as const) {
        const m = await sem.buildRefRun(db, runId, "P0", variant);
        expect(m.artefact).toMatchObject({ runId, policyVersion: "P0@1.0.0", kind: "ref-matrix" });
        expect(m).toMatchObject({ variant, epsilon: 0.2, textVersion: "text@1.0.0" });
        expect(m.nodes).toEqual(text.model.documents.map((x) => x.node));
        expect(m.stats.kept).toBeGreaterThan(0);
        const sums = new Map<number, number>();
        for (const e of m.entries) {
          expect(e.ref).toBeGreaterThan(0.2);
          expect(e.matched.length).toBeGreaterThan(0);
          sums.set(e.source, (sums.get(e.source) ?? 0) + e.rho);
        }
        for (const sum of sums.values()) expect(sum).toBeCloseTo(1, 12);
      }
      const stored = await q.listArtefacts(db, runId, { kind: "ref-matrix" });
      expect(stored.map((x) => (x.payload as unknown as sem.RefMatrix).variant).sort()).toEqual([
        "unweighted",
        "weighted",
      ]);
    });

    it("computes prominence from regions, positions and templates, and lets analytics override it", async () => {
      const structural = await pr.buildProminenceRun(db, runId, "P0");
      expect(structural.artefact).toMatchObject({
        runId,
        policyVersion: "P0@1.0.0",
        kind: "prominence",
      });
      const edge = (p: pr.Prominence, from: string, to: string) =>
        p.edges.find((e) => e.source === o + from && e.target === o + to);
      const sums = new Map<string, number>();
      for (const e of structural.edges) sums.set(e.source, (sums.get(e.source) ?? 0) + e.omega);
      for (const sum of sums.values()) expect(sum).toBeCloseTo(1, 12);
      expect(structural.stats.analytics).toBeNull();

      // Home: "/about.html" and "about.html" both sit in the header <nav> (0.3 each).
      const about = edge(structural, "/", "/about.html");
      expect(about).toMatchObject({ observations: 2, regions: { nav: 2 }, origin: "structural" });
      // The first <main> link on the home page (rank 0) is a full-weight body link.
      expect(edge(structural, "/", "/deep/1.html")?.weight).toBe(1);
      expect(about?.weight).toBeLessThan(1);

      const csv = [
        "source_url,target_url,clicks",
        `${o}/,${o}/deep/1.html,90`,
        `${o}/,${o}/about.html,10`,
        `${o}/,https://external.invalid/page,50`,
      ].join("\n");
      const imported = await pr.importAnalyticsCsv(db, runId, csv, "analytics.csv");
      expect(imported).toHaveLength(3);
      const withClicks = await pr.buildProminenceRun(db, runId, "P0");
      expect(edge(withClicks, "/", "/deep/1.html")).toMatchObject({
        origin: "analytics",
        clicks: 90,
        omega: 0.9,
      });
      expect(edge(withClicks, "/", "/about.html")?.omega).toBeCloseTo(0.1, 12);
      expect(edge(withClicks, "/", "/blog/")).toMatchObject({ origin: "analytics", weight: 0 });
      expect(edge(withClicks, "/blog/post-1.html", "/about.html")?.origin).toBe("structural");
      expect(withClicks.stats.analytics).toMatchObject({
        rows: 3,
        matchedRows: 2,
        overriddenSources: 1,
        unmatched: { external: 1 },
      });
    });

    it("diagnoses the run into the four cases (typed artefact with counts)", async () => {
      const report = await dg.buildDiagnosisRun(db, runId, "P0");
      expect(report.artefact).toMatchObject({
        runId,
        policyVersion: "P0@1.0.0",
        kind: "diagnosis",
      });
      expect(report).toMatchObject({ alpha: 0.1, epsilon: 0.2, refVariant: "weighted" });
      const { counts } = report;
      expect(counts.v4 + counts.v3 + counts.v2 + counts.v1 + counts.unclassified).toBe(
        counts.pairs,
      );
      expect(report.diagnoses).toHaveLength(counts.v4 + counts.v3 + counts.v2 + counts.v1);
      expect(counts.pairs).toBeGreaterThan(0);
      for (const d of report.diagnoses) {
        expect(d.case).toBe(dg.classify(d.rho, d.omega, d.edge !== null, 0.1));
        expect(d.severity).toBeCloseTo(Math.abs(d.omega - d.rho), 12);
        expect(d.simulate).toBe(d.case === "v4" || d.case === "v3");
      }
      const stored = await q.listArtefacts(db, runId, { kind: "diagnosis" });
      expect((stored[0]?.payload as unknown as dg.DiagnosisReport).counts).toEqual(counts);
    });

    it("generates admissible fix candidates, each with its reasons", async () => {
      const list = await fx.buildCandidatesRun(db, runId, "P0");
      expect(list.artefact).toMatchObject({
        runId,
        policyVersion: "P0@1.0.0",
        kind: "fix-candidates",
      });
      // Orphans were never crawled: no text, so REF (and therefore any donor) is undefined.
      const orphanTargets = list.targets.filter((t) => t.reasons.includes("orphan"));
      expect(orphanTargets.length).toBe(rec.orphans.length);
      for (const t of orphanTargets) expect(t).toMatchObject({ hasText: false, kept: 0 });
      expect(list.stats.targetsByReason["deep-page"]).toBe(3);

      const isUtility = fx.utilityMatcher(list.params.candidateUtilityPatterns);
      for (const c of list.candidates) {
        expect(c.donor).not.toBe(c.target);
        expect(c.ref).toBeGreaterThan(list.epsilon);
        expect(isUtility(c.donor)).toBeNull();
        expect(c.section.relation).not.toBeNull();
        if (c.action === "make-visible") expect(c.existingLink?.omega).toBeLessThan(list.alpha);
        expect(c.reasons.length).toBeGreaterThanOrEqual(6);
      }
      for (const t of list.targets) expect(t.kept).toBeLessThanOrEqual(30);
      expect(list.stats.candidates).toBe(list.candidates.length);
    });

    it("computes κ and templateReach for the crawled pages", async () => {
      const effort = await fx.loadDonorEffort(db, runId, "P0");
      expect(effort.get(`${o}/`)).toMatchObject({ kappa: 1, bodyLinks: 16 });
      expect(effort.get(`${o}/blog/`)?.kappa).toBe(2);
      expect(effort.get(`${o}/blog/post-1.html`)?.kappa).toBe(2);
      for (const e of effort.values()) {
        expect(e.kappa).toBeGreaterThanOrEqual(1);
        expect(e.templateReach).toBeGreaterThanOrEqual(1);
      }
    });

    it("rescues the fixture orphans: donors by REF, then by ΔPR, with the revealing channels", async () => {
      const graphBefore = (await gr.deriveGraph(db, runId, "P0")).summary;
      const fetcher = env.rescue();
      try {
        expect(await fetcher.run(runId, "P0")).toEqual({
          runId,
          orphans: 5,
          fetches: 5,
          pages: 5,
          alreadyFetched: 0,
          capReached: false,
        });
        // A second run fetches nothing again.
        expect(await fetcher.run(runId, "P0")).toMatchObject({ fetches: 0, alreadyFetched: 5 });
      } finally {
        await fetcher.close();
      }
      // Rescued pages never reach the link graph or the reconciliation.
      expect((await gr.deriveGraph(db, runId, "P0")).summary).toEqual(graphBefore);
      expect((await d.reconcileDiscovery(db, runId, "P0")).orphans).toEqual(rec.orphans);

      const report = await buildRescueRun(db, runId, "P0", { workers: 2 });
      expect(report.artefact).toMatchObject({
        runId,
        policyVersion: "P0@1.0.0",
        kind: "orphan-rescue",
      });
      expect(report.counts).toMatchObject({ orphans: 5, scored: 5, noPage: 0 });
      expect(report.baseline.orphanNodesAdded).toBe(5);
      const of = (path: string) => {
        const found = report.orphans.find((x) => x.node === o + path);
        if (found === undefined) throw new Error(`no rescue entry for ${path}`);
        return found;
      };
      expect(of("/orphan.html").revealedBy).toEqual(["xml_sitemap"]);
      expect(of("/sitemap-orphan.html").revealedBy).toEqual(["robots_sitemap"]);
      expect(of("/html-only.html").revealedBy).toEqual(["html_sitemap"]);
      expect(of("/rss-orphan.html").revealedBy).toEqual(["feed"]);
      expect(of("/llms-orphan.html").revealedBy).toEqual(["llms_txt"]);

      const donors = (path: string) => of(path).donors.map((x) => x.donor.replace(o, ""));
      // /about.html and /about.html?ref=nav are separate P0 nodes with the same text: equal REF,
      // different ΔPR, so the second stage decides their order.
      const about = of("/orphan.html").donors;
      expect(about.map((x) => x.donor.replace(o, ""))).toEqual([
        "/about.html",
        "/about.html?ref=nav",
      ]);
      expect(about[0]?.ref).toBe(about[1]?.ref);
      expect(about[0]?.deltaPr).toBeGreaterThan(about[1]?.deltaPr as number);
      expect(donors("/orphan.html")).toContain("/about.html"); // internal link audits
      expect(donors("/rss-orphan.html")).toContain("/blog/"); // post summaries
      expect(donors("/llms-orphan.html")).toContain("/"); // redirect chains on the home page
      expect(donors("/html-only.html")).toContain("/"); // flaky/broken/slow links on the home page

      for (const orphan of report.orphans) {
        expect(orphan.donors.length).toBeLessThanOrEqual(5);
        orphan.donors.forEach((x, i) => {
          expect(x.rank).toBe(i + 1);
          expect(x.ref).toBeGreaterThan(report.params.epsilon);
          expect(x.depthAfter).not.toBeNull();
          if (i > 0) expect(x.deltaPr).toBeLessThanOrEqual(orphan.donors[i - 1]?.deltaPr as number);
        });
      }

      // Every rescue donor gets an explanation naming the channel that revealed the orphan.
      const explained = await fx.buildExplanations(db, runId, "P0");
      expect(explained.counts.rescues).toBe(
        report.orphans.reduce((n, x) => n + x.donors.length, 0),
      );
      const aboutRescue = explained.rescues.find(
        (e) => e.donor === `${o}/about.html` && e.target === `${o}/orphan.html`,
      );
      expect(aboutRescue?.lines[0]).toBe(
        "Why the target: /orphan.html is linked from nowhere and was found only via the XML sitemap.",
      );
      expect(aboutRescue?.donorEvidence.matched.length).toBeGreaterThan(0);
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
