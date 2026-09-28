import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  db as q,
  diagnosis,
  discovery,
  fixes,
  makeConfig,
  semantic,
  stats,
  text,
} from "@linklens/core";
import { asQueryable, createPool } from "@linklens/db";
import { buildCounterfactualRun } from "@linklens/counterfactual";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embeddingOptions } from "@linklens/embeddings";
import {
  E3_METHODS,
  E6_METHODS,
  auditInMemory,
  exportBatch,
  loadRunInputs,
  hashingEmbedder,
  importExports,
  modelInfo,
  newManifest,
  parseCorpus,
  runExperiment,
  type Calibration,
  type E3Result,
  type E6Result,
  type E7Result,
  type PolicyCalibration,
  type Stability,
  type ExperimentRun,
} from "../src/index.js";
import { rankOf, reciprocalRank } from "../src/e6-masking.js";
import { e6Rows, fixRows, siteFeatures } from "../src/l13/dataset.js";
import { FEATURES } from "../src/l13/features.js";

// LINKLENS_WRITE_FIXTURES=1 saves each result, in the CLI's --out format, as a fixture for the
// Python analysis tests (analysis/tests/fixtures), so both sides share one shape.
const FIXTURES = new URL("../../../analysis/tests/fixtures/", import.meta.url);
function saveFixture(run: ExperimentRun, name = run.id): void {
  if (process.env["LINKLENS_WRITE_FIXTURES"] !== "1") return;
  mkdirSync(FIXTURES, { recursive: true });
  const json = { experiment: run.id, artefactId: 0, result: run.result };
  writeFileSync(new URL(`${name}.json`, FIXTURES), `${JSON.stringify(json, null, 2)}\n`);
}

const S = "https://eval.test";
// The 40th PageRank percentile, so this small site has weak-authority pages (E3 targets).
const config = makeConfig({ frequentNgramDropPct: 0, auditWeakAuthorityPercentile: 40 });

// Home → guides hub → whale / shark / turtle pages (and a deep chain); an orphan in the sitemap.
type Def = [path: string, title: string, body: string, links: string[]];
const SITE: Def[] = [
  ["/", "Home", "Ocean guides and more.", ["/guides/", "/about"]],
  // About mentions the tides: a donor for the weak /guides/a page (E3).
  ["/about", "About", "About this ocean site. Tides rise.", ["/"]],
  [
    "/guides/",
    "Guides",
    "Whale song. Shark teeth. Turtle nesting. Reef fish.",
    ["/guides/whale", "/guides/shark", "/guides/a"],
  ],
  ["/guides/whale", "Whale song", "Humpback whales sing.", ["/"]],
  ["/guides/shark", "Shark teeth", "Sharks regrow teeth.", ["/"]],
  ["/guides/a", "Tides", "Tides rise.", ["/guides/b"]],
  ["/guides/b", "Currents", "Currents move.", ["/guides/c"]],
  ["/guides/c", "Reefs", "Reef fish shelter.", ["/guides/turtle"]],
  ["/guides/turtle", "Turtle nesting", "Turtles nest on beaches.", ["/"]],
];

// Screaming Frog on the fixture site: /about/ with a slash, a link /guides/ → /guides/c that
// LinkLens lacks (so /guides/c and, after it, /guides/turtle are shallower), a JavaScript-only
// page, and an orphan found through analytics.
const SF = {
  internal: [
    "Address,Content Type,Status Code,Indexability,Crawl Depth,Unique Inlinks",
    `${S}/,text/html,200,Indexable,0,2`,
    `${S}/about/,text/html,200,Indexable,1,1`,
    `${S}/guides/,text/html,200,Indexable,1,1`,
    `${S}/guides/whale,text/html,200,Indexable,2,1`,
    `${S}/guides/shark,text/html,200,Indexable,2,1`,
    `${S}/guides/a,text/html,200,Indexable,2,1`,
    `${S}/guides/b,text/html,200,Indexable,3,1`,
    `${S}/guides/c,text/html,200,Indexable,2,2`,
    `${S}/guides/turtle,text/html,200,Indexable,3,1`,
    `${S}/guides/extra,text/html,200,Indexable,2,0`,
  ].join("\n"),
  inlinks: [
    "Type,Source,Destination,Follow",
    ...[
      ["/", "/guides/"],
      ["/", "/about/"],
      ["/about/", "/"],
      ["/guides/", "/guides/whale"],
      ["/guides/", "/guides/shark"],
      ["/guides/", "/guides/a"],
      ["/guides/", "/guides/c"],
      ["/guides/a", "/guides/b"],
      ["/guides/b", "/guides/c"],
      ["/guides/c", "/guides/turtle"],
    ].map(([a, b]) => `Hyperlink,${S}${a},${S}${b},true`),
    `JavaScript,${S}/guides/,${S}/guides/extra,true`,
  ].join("\n"),
  orphans: ["Address,Source", `${S}/guides/lost,Sitemap`, `${S}/old-page,Google Analytics`].join(
    "\n",
  ),
};

let pool: pg.Pool;
let db: q.Queryable;
let runA: number;
let runB: number;

/** How a re-crawl differs: links dropped, and pages that answered 404, failed, or were not fetched. */
interface Recrawl {
  readonly drop?: string[];
  readonly gone?: string[];
  readonly failed?: string[];
  readonly notFetched?: string[];
}

async function seedRun(siteId: number, change: Recrawl = {}): Promise<number> {
  const { drop = [], gone = [], failed = [], notFetched = [] } = change;
  const run = await q.createRun(db, { siteId, config });
  for (const [path, title, body, links] of SITE) {
    if (notFetched.includes(path)) continue;
    if (gone.includes(path) || failed.includes(path)) {
      await q.insertFetch(db, {
        runId: run.id,
        requestedUrl: S + path,
        finalUrl: S + path,
        statusCode: gone.includes(path) ? 404 : 503,
        contentType: "text/html",
      });
      continue;
    }
    const f = await q.insertFetch(db, {
      runId: run.id,
      requestedUrl: S + path,
      finalUrl: S + path,
      statusCode: 200,
      contentType: "text/html",
    });
    await q.insertPage(db, {
      runId: run.id,
      fetchId: f.id,
      url: S + path,
      title,
      h1: title,
      bodyText: body,
    });
    const kept = links.filter((l) => !drop.includes(`${path}->${l}`));
    await q.insertLinkObservations(
      db,
      kept.map((l, i) => ({
        runId: run.id,
        sourceFetchId: f.id,
        rawHref: l,
        resolvedUrl: S + l,
        anchorText: l,
        domRegion: l === "/" ? "nav" : "main",
        templateSignature: l === "/" ? "nav-block" : `main-${path}`,
        positionIndex: i,
      })),
    );
  }
  await q.insertDiscoveryObservations(db, [
    { runId: run.id, channel: "link_graph", url: `${S}/`, detail: { kind: "seed" } },
    {
      runId: run.id,
      channel: "xml_sitemap",
      url: `${S}/guides/lost`,
      sourceDocument: `${S}/sitemap.xml`,
    },
    { runId: run.id, channel: "feed", url: `${S}/guides/lost`, sourceDocument: `${S}/feed.xml` },
    { runId: run.id, channel: "llms_txt", url: `${S}/about`, sourceDocument: `${S}/llms.txt` },
  ]);
  // Orphan rescue fetched the orphan: a page on the hub's topics (never part of the graph).
  const rescued = await q.insertFetch(db, {
    runId: run.id,
    requestedUrl: `${S}/guides/lost`,
    finalUrl: `${S}/guides/lost`,
    statusCode: 200,
    contentType: "text/html",
    purpose: "rescue",
  });
  await q.insertPage(db, {
    runId: run.id,
    fetchId: rescued.id,
    url: `${S}/guides/lost`,
    title: "Whale song",
    h1: "Whale song",
    bodyText: "Whale song. Shark teeth. Reef fish.",
  });
  await q.setRunStatus(db, run.id, "completed");
  return run.id;
}

async function stubCosine(runId: number, policy: "P3" | "P4" = "P3"): Promise<void> {
  // Whale/shark/turtle pages and the hub point one way, everything else another.
  const { model } = await text.loadTextModel(db, runId, policy);
  const policyVersion = model.policyVersion;
  const nodes = model.documents.map((d) => d.node).sort();
  const vec = (n: string) =>
    Float32Array.from(/whale|shark|turtle|guides\/$/.test(n) ? [1, 0.2] : [0.1, 1]);
  const m: semantic.CosineMatrix = {
    version: semantic.COSINE_VERSION,
    runId,
    policyVersion,
    model: config.embeddingModel,
    dtype: config.embeddingDtype,
    bodyTokens: config.embeddingBodyTokens,
    dimensions: 2,
    nodes,
    contentKeys: nodes,
    upper: [...semantic.cosineUpper(nodes.map(vec))],
  };
  await q.insertArtefact(db, {
    runId,
    policyVersion,
    kind: semantic.COSINE_ARTEFACT,
    payload: m as unknown as q.Json,
  });
}

beforeAll(async () => {
  pool = createPool(inject("databaseUrl"));
  db = asQueryable(pool);
  const site = await q.insertSite(db, { rootUrl: `${S}/` });
  runA = await seedRun(site.id);
  // The re-crawl: the hub no longer links to the shark page.
  // The re-crawl: the hub no longer links to the shark page (the site changed), /guides/b is
  // gone (404, the site), /guides/c failed (503, the crawl) and /about was linked but not fetched
  // (the crawl).
  runB = await seedRun(site.id, {
    drop: ["/guides/->/guides/shark"],
    gone: ["/guides/b"],
    failed: ["/guides/c"],
    notFetched: ["/about"],
  });
  for (const run of [runA, runB]) {
    await stubCosine(run);
    await buildCounterfactualRun(db, run, "P3", { workers: 1 });
    await fixes.buildFixRanking(db, run, "P3");
    await diagnosis.buildDiagnosisRun(db, run, "P3");
  }
  await fixes.buildExplanations(db, runA, "P3");
  // Run A is also ranked under P4 (as a batch with rankAllPolicies does), for E1's fix Jaccard.
  await stubCosine(runA, "P4");
  await buildCounterfactualRun(db, runA, "P4", { workers: 1 });
  await fixes.buildFixRanking(db, runA, "P4");
});

afterAll(async () => {
  await pool.end();
});

describe("experiments on a stored run", () => {
  it("E1: compares the six policies", async () => {
    const run1 = await runExperiment(db, "E1", { runId: runA, policy: "P3" });
    saveFixture(run1);
    const r = run1 as {
      result: {
        policies: {
          policy: string;
          pagerankSpearman: number | null;
          topFixesJaccard: number | null;
        }[];
      };
    };
    expect(r.result.policies.map((p) => p.policy)).toEqual(["P0", "P1", "P2", "P3", "P4", "P5"]);
    const p3 = r.result.policies.find((p) => p.policy === "P3");
    expect(p3).toMatchObject({ pagerankSpearman: 1, topFixesJaccard: 1 });

    // Every pair of policies.
    const pairs = (run1.result as { pairs: stats.PolicyPairComparison[] }).pairs;
    expect(pairs).toHaveLength(15);
    const pair = (a: string, b: string) => pairs.find((x) => x.a === a && x.b === b);
    // No redirects or canonicals on this site: P3 and P4 agree completely, fixes included.
    expect(pair("P3", "P4")).toMatchObject({
      nodeDelta: 0,
      nodeJaccard: 1,
      orphanJaccard: 1,
      pagerankSpearman: 1,
      meanDepthShift: 0,
      maxAbsDepthShift: 0,
      topFixesJaccard: 1,
    });
    // Fix lists are compared only where both policies were ranked.
    expect(pair("P0", "P3")?.topFixesJaccard).toBeNull();
    expect(pairs.filter((x) => x.topFixesJaccard !== null).map((x) => `${x.a}-${x.b}`)).toEqual([
      "P3-P4",
    ]);
    for (const x of pairs) {
      expect(x.orphanJaccard).toBeGreaterThanOrEqual(0);
      expect(x.sharedNodes).toBeLessThanOrEqual(Math.min(x.nodesA, x.nodesB));
    }
  });

  it("E2: finds the orphan through the sitemap and the feed", async () => {
    const r = await runExperiment(db, "E2", { runId: runA, policy: "P3" });
    saveFixture(r);
    const result = r.result as {
      orphans: number;
      leaveOneOut: { removed: string; orphansLost: number }[];
      orphansBy: discovery.ChannelLeaveOneOut["orphansBy"];
      removals: discovery.ChannelRemoval[];
    };
    expect(result.orphans).toBe(1);
    expect(result.leaveOneOut.every((x) => x.orphansLost === 0)).toBe(true); // found twice

    // Each of the six channels removed and the reconciliation recomputed.
    expect(result.removals.map((x) => x.channel)).toEqual([
      "link_graph",
      "xml_sitemap",
      "robots_sitemap",
      "html_sitemap",
      "feed",
      "llms_txt",
    ]);
    const removal = (c: string) => result.removals.find((x) => x.channel === c);
    // /guides/lost is in the sitemap and the feed: neither alone is needed.
    expect(removal("xml_sitemap")).toMatchObject({
      orphansTotal: 1,
      orphansExclusive: 0,
      orphansExclusiveShare: 0,
      orphansWithout: 1,
    });
    expect(result.orphansBy.several).toBe(1);
    // Without the link graph, only pages the other channels list remain; no orphan is lost.
    expect(removal("link_graph")).toMatchObject({ orphansExclusive: 0, inventoryWithout: 2 });
    expect(removal("link_graph")?.pagesExclusive).toBeGreaterThan(0);
    // llms.txt lists /about, which no other channel records here (the fixture's link graph
    // channel holds only the seed): a page gained, but no orphan, since /about is reachable.
    expect(removal("llms_txt")).toMatchObject({
      pagesTotal: 1,
      pagesExclusive: 1,
      orphansTotal: 0,
      orphansExclusive: 0,
    });
  });

  it("E3: applies each method's top-k fixes together on the weak and orphan pages", async () => {
    await expect(runExperiment(db, "E3", { runId: runA, policy: "P3" })).rejects.toThrow(
      /embedder/,
    );
    const embedder = hashingEmbedder(embeddingOptions(config, tmpdir()));
    const r = await runExperiment(db, "E3", { runId: runA, policy: "P3", embedder });
    saveFixture(r);
    const result = r.result as E3Result;
    expect(result.ks).toEqual([10, 25, 50]);
    expect(result.randomDraws).toBe(20);
    expect(result.targets.orphan).toBe(1);
    expect(result.targets.weak).toBeGreaterThan(0);
    // The rescued orphan page is on the hub's topics: the hub can donate to it.
    expect(result.pool.orphanTargetsWithDonors).toBe(1);
    expect(result.pool.weakPairs).toBeGreaterThan(0);
    for (const { k, methods } of result.byK) {
      expect(methods.map((m) => m.method)).toEqual([...E3_METHODS]);
      for (const m of methods) {
        expect(m.selected).toBe(Math.min(k, result.pool.pairs));
        expect(Number.isFinite(m.totalDeltaPr)).toBe(true);
      }
    }
    // With the whole pool applied, the orphan becomes reachable whatever the method.
    const all = result.byK.find((b) => b.k >= result.pool.pairs);
    if (all !== undefined) {
      for (const m of all.methods) expect(m.newlyReachable).toBeGreaterThanOrEqual(1);
    }
    // Deterministic, and nothing but the evaluation artefact is written.
    const again = await runExperiment(db, "E3", { runId: runA, policy: "P3", embedder });
    expect(again.result).toEqual(r.result);
    expect(r.artefact).toMatchObject({
      runId: runA,
      policyVersion: "P3@1.0.0",
      kind: "evaluation-E3",
    });
    expect(
      (r.artefact.payload as { options: { embedder?: unknown } }).options.embedder,
    ).toBeUndefined();
  });

  it("E4: separates site change from method instability between the two crawls", async () => {
    const r = await runExperiment(db, "E4", { runId: runA, runB, policy: "P3" });
    saveFixture(r);
    const s = r.result as Stability;
    const cls = (path: string) => s.classes.find((c) => c.node === S + path);
    expect(cls("/guides")).toMatchObject({ status: "changed", cause: "site" }); // P3 form
    expect(cls("/guides/b")).toMatchObject({ status: "onlyA", cause: "site", reason: "gone" });
    expect(cls("/guides/c")).toMatchObject({ status: "onlyA", cause: "method", reason: "failed" });
    expect(cls("/about")).toMatchObject({
      status: "onlyA",
      cause: "method",
      reason: "not-admitted",
    });
    expect(cls("/guides/whale")).toMatchObject({ status: "unchanged", cause: null });
    expect(s.pages).toMatchObject({ union: 9, unchanged: 5, changed: 1, onlyA: 3, onlyB: 0 });
    expect(s.pages.site.gone).toBe(1);
    expect(s.pages.method).toEqual({ "not-admitted": 1, failed: 1 });
    expect(s.siteChangeShare).toBeCloseTo(2 / 9);
    expect(s.methodShare).toBeCloseTo(2 / 9);
    expect(s.discoveryDocuments).toMatchObject({ changed: 0, onlyA: 0, onlyB: 0 });

    const c = s.comparisons;
    expect(c.observed.nodeJaccard).toBeCloseTo(6 / 9);
    // Without the crawl's misses, only the site's differences remain: B lacks /guides/b only.
    expect(c.siteChange.nodeJaccard).toBeCloseTo(6 / 7);
    // Identical pages and documents give identical results: no method instability.
    expect(c.samePages).toMatchObject({
      nodeJaccard: 1,
      orphanJaccard: 1,
      topFixesJaccard: 1,
      crawledA: 5,
      crawledB: 5,
    });
    expect(c.samePages.pagerankSpearman ?? 1).toBeCloseTo(1, 9);
    // B missed nothing A had for method reasons, so B's coverage comparison is trivial.
    expect(c.coverageB.nodeJaccard).toBe(1);
    expect(c.coverageA.nodeJaccard).toBeCloseTo(7 / 9);

    await expect(runExperiment(db, "E4", { runId: runA, policy: "P3" })).rejects.toThrow(
      /second run/,
    );
  });

  it("the in-memory pipeline reproduces the stored ranking", async () => {
    const inputs = await loadRunInputs(db, runA, "P3");
    const outcome = auditInMemory(inputs, { policyId: "P3", k: 10 });
    const stored = (await q.listArtefacts(db, runA, {
      kind: fixes.FIX_RANKING_ARTEFACT,
      policyVersion: "P3@1.0.0",
    })) as { payload: unknown }[];
    const ranking = stored[0]?.payload as fixes.FixRanking;
    expect(outcome.fixes).toBe(ranking.fixes.length);
    expect([...outcome.topFixes]).toEqual(
      ranking.fixes.slice(0, 10).map((f) => `${f.donor} -> ${f.target}`),
    );
  });

  it("E5: calibrates against Screaming Frog under P0 and P3, explaining each disagreement", async () => {
    const r = await runExperiment(db, "E5", { runId: runA, policy: "P3", screamingFrog: SF });
    saveFixture(r);
    const c = r.result as Calibration;
    const [p0, p3] = c.policies as [PolicyCalibration, PolicyCalibration];
    expect([p0.policy, p3.policy]).toEqual(["P0", "P3"]);
    expect(p3.urls).toMatchObject({ linklens: 9, screamingFrog: 10, common: 9 });
    expect(p0.urls.common).toBe(8); // /about vs /about/
    const cat = (x: PolicyCalibration, kind: string, path: string) =>
      x.disagreements.find((d) => d.kind === kind && d.node === S + path)?.category;
    expect(cat(p0, "url-only-screaming-frog", "/about/")).toBe("normalisation");
    expect(cat(p3, "url-only-screaming-frog", "/guides/extra")).toBe("link-not-extracted");
    expect(cat(p3, "depth", "/guides/c")).toBe("link-not-extracted");
    expect(cat(p3, "depth", "/guides/turtle")).toBe("cascade");
    expect(p3.depth).toMatchObject({ pages: 9, seedDiffers: false });
    expect(p3.orphans).toMatchObject({ linklens: 1, screamingFrog: 2, common: 1 });
    expect(cat(p3, "orphan-only-screaming-frog", "/old-page")).toBe("not-in-linklens-channels");
    expect(p3.inlinks.spearman).not.toBeNull();
    await expect(runExperiment(db, "E5", { runId: runA, policy: "P3" })).rejects.toThrow(
      /Screaming Frog/,
    );
  });

  it("E6: masks editorial links and ranks the donors by every method", async () => {
    await expect(runExperiment(db, "E6", { runId: runA, policy: "P3" })).rejects.toThrow(
      /embedder/,
    );
    const embedder = hashingEmbedder(embeddingOptions(config, tmpdir()));
    const e6 = await runExperiment(db, "E6", { runId: runA, policy: "P3", embedder });
    saveFixture(e6);
    const r6 = e6.result as E6Result;
    expect(r6.repeats.map((r) => r.seed)).toEqual([42, 43, 44, 45, 46]);
    expect(r6.options).toMatchObject({ ks: [5, 10, 20], stripAnchorsFromBody: true });
    for (const r of r6.repeats) {
      expect(r.share).toBeGreaterThanOrEqual(0.1);
      expect(r.share).toBeLessThanOrEqual(0.2);
      expect(r.masked).toBeGreaterThanOrEqual(1);
      expect(r.queries).toBeLessThanOrEqual(r.masked);
      expect(Object.keys(r.methods).sort()).toEqual([...E6_METHODS].sort());
      // The random baseline is its exact expectation.
      expect(r.methods.random?.auc ?? 0.5).toBe(0.5);
    }
    // Deterministic for a seed.
    const again = await runExperiment(db, "E6", { runId: runA, policy: "P3", embedder });
    expect(again.result).toEqual(e6.result);
  });

  it("L13: E6 label rows (one positive per query, the hybrid σ reproduces E6) and fix rows", async () => {
    const embedder = hashingEmbedder(embeddingOptions(config, tmpdir()));
    const inputs = await loadRunInputs(db, runA, "P3");
    const rows = await e6Rows(inputs, "P3", embedder);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) for (const f of FEATURES) expect(r).toHaveProperty(f);
    const byQuery = new Map<string, typeof rows>();
    for (const r of rows) byQuery.set(r.query, [...(byQuery.get(r.query) ?? []), r]);
    for (const q of byQuery.values()) expect(q.filter((r) => r.label === 1)).toHaveLength(1);
    // E6's hidden links are never linked in the masked world: no candidate has an existing edge.
    expect(rows.every((r) => r.omega_existing === 0)).toBe(true);
    // Same masking, same candidates: the REF-gated cosine column gives E6's refGateCosine MRR.
    const e6 = (await runExperiment(db, "E6", { runId: runA, policy: "P3", embedder }))
      .result as E6Result;
    for (let rep = 0; rep < config.l13Repeats; rep++) {
      const qs = [...byQuery.values()].filter((q) => q[0]?.repeat === rep);
      const rr = qs.map((q) =>
        reciprocalRank(
          rankOf(
            q.map((r) => r.sigma_hybrid),
            q.findIndex((r) => r.label === 1),
          ),
        ),
      );
      const methods = e6.repeats[rep]?.methods;
      expect(qs.length).toBe(e6.repeats[rep]?.queries);
      expect(rr.reduce((a, b) => a + b, 0) / rr.length).toBeCloseTo(
        methods?.refGateCosine?.mrr ?? NaN,
        12,
      );
    }
    // Fix rows are the stored ranking's fixes, in its order.
    const stored = (await q.listArtefacts(db, runA, {
      kind: fixes.FIX_RANKING_ARTEFACT,
      policyVersion: "P3@1.0.0",
    })) as { payload: unknown }[];
    const ranking = stored[0]?.payload as fixes.FixRanking;
    const fr = fixRows(siteFeatures(inputs, "P3"), inputs.config);
    expect(fr.map((f) => f.fix_id)).toEqual(ranking.fixes.map((f) => f.id));
  });

  it("E7: re-ranks under every σ, an ε sweep and an α sweep, with E3 and E6 per setting", async () => {
    await expect(runExperiment(db, "E7", { runId: runA, policy: "P3" })).rejects.toThrow(
      /embedder/,
    );
    const embedder = hashingEmbedder(embeddingOptions(config, tmpdir()));
    const e7 = await runExperiment(db, "E7", { runId: runA, policy: "P3", embedder });
    saveFixture(e7);
    const r = e7.result as E7Result;
    // Per σ: 8 ε + 6 α − 1 shared under S, plus S_imp at the default ε and α (L12).
    expect(r.rows).toHaveLength(4 * (8 + 6 - 1 + 1));
    expect(r.sigmaPairs).toHaveLength(6);
    const row = (sigma: string, epsilon: number, alpha: number, scoring = "S") =>
      r.rows.find(
        (x) =>
          x.sigma === sigma && x.epsilon === epsilon && x.alpha === alpha && x.scoring === scoring,
      );
    const def = row("refGateCosine", 0.2, 0.1);
    expect(def).toMatchObject({ isDefault: true, topKJaccardDefault: 1 });

    // The default setting agrees with E3 and E6 run on their own.
    const e3 = (await runExperiment(db, "E3", { runId: runA, policy: "P3", embedder }))
      .result as E3Result;
    const e3LinkLens = e3.byK.map(
      (b) => b.methods.find((m) => m.method === "linklens")?.totalDeltaPr,
    );
    expect(r.e3Ks.map((k) => def?.e3.linklens[k])).toEqual(e3LinkLens);
    const e6 = (await runExperiment(db, "E6", { runId: runA, policy: "P3", embedder }))
      .result as E6Result;
    expect(def?.e6).toEqual(e6.summary.refGateCosine);
    expect(row("cosineOnly", 0.2, 0.1)?.e6).toEqual(e6.summary.cosine);
    expect(row("refOnly", 0.05, 0.1)?.e6).toEqual(e6.summary.ref); // REF alone: ε-free in E6

    // E6 does not depend on α.
    expect(row("blended", 0.2, 0.3)?.e6).toEqual(row("blended", 0.2, 0.05)?.e6);

    // The scoring sweep (L12): each σ also under S_imp at the default ε and α. The same fixes are
    // ranked (another order), E3 is measured, and E6 equals S's by construction.
    for (const sigma of ["refGateCosine", "cosineOnly", "refOnly", "blended"]) {
      const s = row(sigma, 0.2, 0.1, "S");
      const imp = row(sigma, 0.2, 0.1, "S_imp");
      expect(imp).toMatchObject({ isDefault: false, sweeps: ["scoring"] });
      expect(imp?.fixes).toBe(s?.fixes);
      expect(imp?.e6).toEqual(s?.e6);
      for (const k of r.e3Ks) expect(Number.isFinite(imp?.e3.linklens[k])).toBe(true);
      expect(s?.sweeps).toContain("scoring");
    }
    expect(r.defaults.scoring).toBe("S");
    for (const x of r.rows) {
      expect(x.topKJaccardDefault).toBeGreaterThanOrEqual(0);
      expect(x.topKJaccardDefault).toBeLessThanOrEqual(1);
    }
    // Deterministic.
    expect((await runExperiment(db, "E7", { runId: runA, policy: "P3", embedder })).result).toEqual(
      r,
    );
  });

  it("E8: writes a rating sheet, then summarises the filled one", async () => {
    const sheet = (await runExperiment(db, "E8", { runId: runA, policy: "P3", k: 5 })).result as {
      sheet: string;
    };
    const rows = sheet.sheet.trimEnd().split("\r\n");
    expect(rows[0]).toMatch(/^item_id,rank,/);
    const filled = [
      rows[0],
      ...rows.slice(1).map((r, i) => `${r.replace(/,,,$/, "")},ana,${5 - (i % 5)},yes`),
    ].join("\n");
    const e8 = await runExperiment(db, "E8", { runId: runA, policy: "P3", ratingsCsv: filled });
    saveFixture(e8);
    const summary = e8.result as { ratings: number; raters: string[] };
    expect(summary.ratings).toBe(rows.length - 1);
    expect(summary.raters).toEqual(["ana"]);
  });
});

describe("corpus export", () => {
  it("writes tidy metrics for every policy of a completed site", async () => {
    const corpus = parseCorpus(`
version: 1
seed: 42
policy: P3
sigma: refGateCosine
refVariant: weighted
classes:
  docs: { label: Documentation }
sites:
  - { id: ocean, url: "${S}/", architecture_class: docs, notes: "fixture, with a comma" }
`);
    const git = { commit: "abc", branch: "main", dirty: false, changes: [], diffSha256: null };
    const m = newManifest({
      batchId: "int",
      corpus,
      corpusFile: "corpus.yaml",
      config,
      git,
      model: modelInfo(config, tmpdir()),
      lockfileSha256: null,
      now: "2026-01-01T00:00:00.000Z",
    });
    Object.assign(m.sites[0] as object, {
      status: "completed",
      runId: runA,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:30.000Z",
    });
    const dir = mkdtempSync(join(tmpdir(), "linklens-corpus-"));
    try {
      const embedder = hashingEmbedder(embeddingOptions(config, tmpdir()));
      const noLog = () => undefined;
      // E5: the site's Screaming Frog exports, imported into the batch.
      const from = mkdtempSync(join(tmpdir(), "linklens-sf-"));
      writeFileSync(join(from, "Internal_All.csv"), SF.internal);
      writeFileSync(join(from, "all_inlinks.csv"), SF.inlinks);
      writeFileSync(join(from, "orphan_pages.csv"), SF.orphans);
      const imported = importExports(dir, "ocean", from, "2026-01-02T00:00:00.000Z", "21.0");
      expect(imported.files.map((f) => [f.name, f.rows])).toEqual([
        ["internal_all.csv", 10],
        ["all_inlinks.csv", 11],
        ["orphan_pages.csv", 2],
      ]);
      rmSync(from, { recursive: true, force: true });
      // The re-crawl wave: the same site, crawled again as run B.
      const wave = newManifest({
        batchId: "int-recrawl",
        corpus,
        corpusFile: "corpus.yaml",
        config,
        git,
        model: modelInfo(config, tmpdir()),
        lockfileSha256: null,
        now: "2026-01-15T00:00:00.000Z",
        wave: { of: "int", afterDays: 14 },
      });
      Object.assign(wave.sites[0] as object, { status: "completed", runId: runB });
      const { record, metrics } = await exportBatch(db, m, corpus, dir, git, noLog, embedder, wave);
      expect(record.files.map((f) => f.name)).toEqual([
        "metrics.csv",
        "channels.csv",
        "e3.csv",
        "e4.csv",
        "e4_pages.csv",
        "e5.csv",
        "e5_categories.csv",
        "e5_disagreements.csv",
        "e6.csv",
        "e7.csv",
        "e7_sigma_pairs.csv",
        "policy_pairs.csv",
        "sites.csv",
        "stages.csv",
      ]);
      const lines = readFileSync(join(dir, "metrics.csv"), "utf8").trimEnd().split("\r\n");
      expect(lines).toHaveLength(metrics + 1);
      const rows = lines.slice(1).map((l) => l.split(","));
      const policies = [...new Set(rows.map((r) => r[4]))];
      expect(policies).toEqual(["P0", "P1", "P2", "P3", "P4", "P5"]);
      const get = (policy: string, metric: string) =>
        rows.find((r) => r[4] === policy && r[7] === metric)?.[8];
      expect(get("P3", "discovery.orphans")).toBe("1");
      expect(get("P3", "sensitivity.pagerank_spearman")).toBe("1");
      expect(Number(get("P3", "fixes.count"))).toBeGreaterThan(0);
      expect(get("P0", "fixes.count")).toBeUndefined(); // ranked under P3 and P4 only
      expect(Number(get("P4", "fixes.count"))).toBeGreaterThan(0);
      const pairRows = readFileSync(join(dir, "policy_pairs.csv"), "utf8")
        .trimEnd()
        .split("\r\n")
        .slice(1)
        .map((l) => l.split(","));
      expect(new Set(pairRows.map((r) => `${r[4]}-${r[5]}`)).size).toBe(15);
      const pairValue = (a: string, b: string, metric: string) =>
        pairRows.find((r) => r[4] === a && r[5] === b && r[7] === metric)?.[8];
      expect(pairValue("P3", "P4", "top_fixes_jaccard")).toBe("1");
      expect(pairValue("P0", "P3", "top_fixes_jaccard")).toBeUndefined();
      expect(pairValue("P0", "P1", "orphan_jaccard")).toBe("1");
      expect(pairRows.every((r) => r[6] === "10")).toBe(true); // top_k
      const channelRows = readFileSync(join(dir, "channels.csv"), "utf8")
        .trimEnd()
        .split("\r\n")
        .slice(1)
        .map((l) => l.split(","));
      expect(channelRows).toHaveLength(3 + 6 * 7);
      const channelValue = (channel: string, metric: string) =>
        channelRows.find((r) => r[6] === channel && r[7] === metric)?.[8];
      expect(channelValue("all", "orphans")).toBe("1");
      expect(channelValue("all", "orphans_several_channels")).toBe("1");
      expect(channelValue("feed", "orphans_exclusive")).toBe("0");
      expect(channelValue("feed", "orphans_exclusive_share")).toBe("0");
      expect(channelRows.every((r) => r[4] === "P3" && r[5] === "P3@1.0.0")).toBe(true);
      const e3Rows = readFileSync(join(dir, "e3.csv"), "utf8")
        .trimEnd()
        .split(String.fromCharCode(13, 10))
        .slice(1)
        .map((l) => l.split(","));
      const e3Value = (k: string, method: string, metric: string) =>
        e3Rows.find((r) => r[6] === k && r[7] === method && r[8] === metric)?.[9];
      expect(e3Value("", "site", "targets_orphan")).toBe("1");
      for (const k of ["10", "25", "50"]) {
        for (const method of E3_METHODS) {
          expect(Number.isFinite(Number(e3Value(k, method, "total_delta_pr")))).toBe(true);
        }
      }
      expect(e3Value("10", "random", "total_delta_pr_sd")).toBeDefined();
      expect(e3Value("10", "linklens", "total_delta_pr_sd")).toBeUndefined();
      const e4Rows = readFileSync(join(dir, "e4.csv"), "utf8")
        .trimEnd()
        .split(String.fromCharCode(13, 10))
        .slice(1)
        .map((l) => l.split(","));
      const e4Value = (comparison: string, metric: string) =>
        e4Rows.find((r) => r[5] === comparison && r[6] === metric)?.[7];
      expect(e4Rows.every((r) => r[3] === String(runA) && r[4] === String(runB))).toBe(true);
      expect(e4Value("pages", "unchanged")).toBe("5");
      expect(e4Value("pages", "site_gone")).toBe("1");
      expect(e4Value("pages", "method_failed")).toBe("1");
      expect(e4Value("samePages", "node_jaccard")).toBe("1");
      expect(Number(e4Value("siteChange", "node_jaccard"))).toBeCloseTo(6 / 7);
      const pageRows = readFileSync(join(dir, "e4_pages.csv"), "utf8")
        .trimEnd()
        .split(String.fromCharCode(13, 10));
      expect(pageRows).toHaveLength(1 + 9);
      expect(pageRows).toContain(`int,ocean,docs,${S}/guides/c,onlyA,method,failed`);
      const e5Rows = readFileSync(join(dir, "e5.csv"), "utf8")
        .trimEnd()
        .split(String.fromCharCode(13, 10))
        .slice(1)
        .map((l) => l.split(","));
      const e5Value = (policy: string, metric: string) =>
        e5Rows.find((r) => r[4] === policy && r[6] === metric)?.[7];
      expect(e5Value("P3", "urls_common")).toBe("9");
      expect(e5Value("P0", "urls_common")).toBe("8");
      expect(e5Value("P3", "disagreements_depth")).toBe("2");
      const categories = readFileSync(join(dir, "e5_categories.csv"), "utf8");
      expect(categories).toContain("P0,url-only-screaming-frog,normalisation,1,");
      expect(categories).toContain("they are one page under P3");
      const e6Rows = readFileSync(join(dir, "e6.csv"), "utf8")
        .trimEnd()
        .split(String.fromCharCode(13, 10))
        .slice(1)
        .map((l) => l.split(","));
      expect(new Set(e6Rows.map((r) => r[5]))).toEqual(new Set(["0", "1", "2", "3", "4"]));
      const e6Of = (repeat: string, method: string, metric: string) =>
        e6Rows.find((r) => r[5] === repeat && r[7] === method && r[8] === metric)?.[9];
      expect(Number(e6Of("0", "masking", "share"))).toBeGreaterThanOrEqual(0.1);
      expect(e6Of("0", "random", "auc")).toBe("0.5");
      expect(e6Of("0", "refGateCosine", "recall@10")).toBeDefined();
      // The shared E6 run carries the extra gates, but e6.csv is E6's own metrics only.
      expect(e6Rows.some((r) => r[7]?.startsWith("gate"))).toBe(false);
      const e7Rows = readFileSync(join(dir, "e7.csv"), "utf8")
        .trimEnd()
        .split(String.fromCharCode(13, 10))
        .slice(1)
        .map((l) => l.split(","));
      // Columns: … sigma 5, epsilon 6, alpha 7, scoring 8, is_default 9, sweeps 10, metric 11, value 12.
      const e7Of = (sigma: string, epsilon: string, alpha: string, metric: string, scoring = "S") =>
        e7Rows.find(
          (r) =>
            r[5] === sigma &&
            r[6] === epsilon &&
            r[7] === alpha &&
            r[8] === scoring &&
            r[11] === metric,
        )?.[12];
      expect(e7Of("refGateCosine", "0.2", "0.1", "topk_jaccard_default")).toBe("1");
      expect(e7Rows.find((r) => r[9] === "1")?.[10]).toBe("sigma|epsilon|alpha|scoring");
      expect(new Set(e7Rows.map((r) => `${r[5]}|${r[6]}|${r[7]}|${r[8]}`)).size).toBe(
        4 * (8 + 6 - 1 + 1),
      );
      expect(e7Rows.filter((r) => r[8] === "S_imp").every((r) => r[10] === "scoring")).toBe(true);
      expect(e7Of("blended", "0.2", "0.1", "e3_linklens@10", "S_imp")).toBeDefined();
      expect(e7Of("cosineOnly", "0.05", "0.1", "e6_mrr")).toBeDefined();
      const pairs = readFileSync(join(dir, "e7_sigma_pairs.csv"), "utf8")
        .trimEnd()
        .split(String.fromCharCode(13, 10));
      expect(pairs).toHaveLength(1 + 6);
      expect(rows.filter((r) => r[6] === "1").every((r) => r[4] === "P3")).toBe(true);
      // The same rows every time (determinism).
      const again = await exportBatch(db, m, corpus, dir, git, noLog, embedder, wave);
      expect(again.record.files.map((f) => f.sha256)).toEqual(record.files.map((f) => f.sha256));
      const sites = readFileSync(join(dir, "sites.csv"), "utf8");
      expect(sites).toContain('"fixture, with a comma",completed');
      expect(sites).toContain(",90,");
      if (process.env["LINKLENS_WRITE_FIXTURES"] === "1") {
        const out = new URL("corpus-export/", FIXTURES);
        mkdirSync(out, { recursive: true });
        for (const f of record.files) {
          writeFileSync(new URL(f.name, out), readFileSync(join(dir, f.name)));
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
