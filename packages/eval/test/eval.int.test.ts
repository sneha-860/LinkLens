import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { db as q, diagnosis, fixes, makeConfig, semantic, text } from "@linklens/core";
import { asQueryable, createPool } from "@linklens/db";
import { buildCounterfactualRun } from "@linklens/counterfactual";
import { mkdirSync, writeFileSync } from "node:fs";
import { runExperiment, type ExperimentRun } from "../src/index.js";

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
const config = makeConfig({ frequentNgramDropPct: 0 });

// Home → guides hub → whale / shark / turtle pages (and a deep chain); an orphan in the sitemap.
type Def = [path: string, title: string, body: string, links: string[]];
const SITE: Def[] = [
  ["/", "Home", "Ocean guides and more.", ["/guides/", "/about"]],
  ["/about", "About", "About this ocean site.", ["/"]],
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

let pool: pg.Pool;
let db: q.Queryable;
let runA: number;
let runB: number;

async function seedRun(siteId: number, drop: string[] = []): Promise<number> {
  const run = await q.createRun(db, { siteId, config });
  for (const [path, title, body, links] of SITE) {
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
  await q.setRunStatus(db, run.id, "completed");
  return run.id;
}

async function stubCosine(runId: number): Promise<void> {
  // Whale/shark/turtle pages and the hub point one way, everything else another.
  const { model } = await text.loadTextModel(db, runId, "P3");
  const nodes = model.documents.map((d) => d.node).sort();
  const vec = (n: string) =>
    Float32Array.from(/whale|shark|turtle|guides\/$/.test(n) ? [1, 0.2] : [0.1, 1]);
  const m: semantic.CosineMatrix = {
    version: semantic.COSINE_VERSION,
    runId,
    policyVersion: "P3@1.0.0",
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
    policyVersion: "P3@1.0.0",
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
  runB = await seedRun(site.id, ["/guides/->/guides/shark"]);
  for (const run of [runA, runB]) {
    await stubCosine(run);
    await buildCounterfactualRun(db, run, "P3", { workers: 1 });
    await fixes.buildFixRanking(db, run, "P3");
    await diagnosis.buildDiagnosisRun(db, run, "P3");
  }
  await fixes.buildExplanations(db, runA, "P3");
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
  });

  it("E2: finds the orphan through the sitemap and the feed", async () => {
    const r = await runExperiment(db, "E2", { runId: runA, policy: "P3" });
    saveFixture(r);
    const result = r.result as {
      orphans: number;
      leaveOneOut: { removed: string; orphansLost: number }[];
    };
    expect(result.orphans).toBe(1);
    expect(result.leaveOneOut.every((x) => x.orphansLost === 0)).toBe(true); // found twice
  });

  it("E3: compares LinkLens's picks with the baselines", async () => {
    const r = await runExperiment(db, "E3", { runId: runA, policy: "P3" });
    saveFixture(r);
    const result = r.result as {
      targets: number;
      methods: { method: string; meanDeltaPr: number | null; meanShareOfBest: number | null }[];
    };
    expect(result.targets).toBeGreaterThan(0);
    const oracle = result.methods.find((m) => m.method === "oracle");
    const ours = result.methods.find((m) => m.method === "linklens");
    expect(oracle?.meanShareOfBest).toBe(1);
    expect(ours?.meanDeltaPr).toBeLessThanOrEqual(oracle?.meanDeltaPr as number);
    expect(r.artefact).toMatchObject({
      runId: runA,
      policyVersion: "P3@1.0.0",
      kind: "evaluation-E3",
    });
  });

  it("E4: measures stability between the two crawls", async () => {
    const r = await runExperiment(db, "E4", { runId: runA, runB, policy: "P3" });
    saveFixture(r);
    const s = r.result as {
      pagesJaccard: number;
      edgesJaccard: number;
      pagerankSpearman: number | null;
      caseAgreement: number | null;
    };
    expect(s.pagesJaccard).toBe(1); // same pages
    expect(s.edgesJaccard).toBeLessThan(1); // one link gone
    expect(s.edgesJaccard).toBeGreaterThan(0.8);
    expect(s.pagerankSpearman).toBeGreaterThan(0.5);
    await expect(runExperiment(db, "E4", { runId: runA, policy: "P3" })).rejects.toThrow(
      /second run/,
    );
  });

  it("E5: calibrates against a Screaming Frog export", async () => {
    const csv = [
      "Address,Content Type,Status Code,Crawl Depth,Unique Inlinks",
      `${S}/,text/html,200,0,4`,
      `${S}/about,text/html,200,1,1`,
      `${S}/guides/,text/html,200,1,1`,
      `${S}/guides/whale,text/html,200,2,1`,
    ].join("\n");
    const r = await runExperiment(db, "E5", { runId: runA, policy: "P3", screamingFrogCsv: csv });
    saveFixture(r);
    const c = r.result as { common: number; depth: { exact: number } };
    expect(c.common).toBe(4);
    expect(c.depth.exact).toBe(1);
  });

  it("E6 and E7: hide links and recover them", async () => {
    const e6 = await runExperiment(db, "E6", { runId: runA, policy: "P3", sample: 3 });
    saveFixture(e6);
    const r6 = e6.result as { hidden: unknown[]; bySigma: Record<string, { mrr: number | null }> };
    expect(r6.hidden).toHaveLength(3);
    expect(Object.keys(r6.bySigma)).toEqual(["refGateCosine"]);
    const e7 = await runExperiment(db, "E7", { runId: runA, policy: "P3", sample: 3 });
    saveFixture(e7);
    const r7 = e7.result as { bySigma: Record<string, unknown>; candidateRecall: number | null };
    expect(Object.keys(r7.bySigma).sort()).toEqual([
      "blended",
      "cosineOnly",
      "refGateCosine",
      "refOnly",
    ]);
    expect(r7.candidateRecall).toBe(1);
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
