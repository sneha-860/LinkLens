import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { db as q, fixes, makeConfig } from "@linklens/core";
import { asQueryable, createPool } from "@linklens/db";
import { buildCounterfactualRun, type TimedResult } from "../src/index.js";

const S = "https://fixture.test";
// Tiny site: keep every term (the boilerplate quota would otherwise eat the topic words).
const config = makeConfig({
  userAgent: "LinkLensBot/0.1 (+https://linklens.test/bot)",
  frequentNgramDropPct: 0,
});

// Home → guides hub → a → b → c → whale-song: the whale page is 5 clicks deep, although the hub
// talks about whale song.
const PAGES: [path: string, title: string, body: string, links: string[]][] = [
  ["/", "Home", "Welcome. Guides about the ocean.", ["/guides/"]],
  ["/guides/", "Guides", "Ocean guides. Whale song: humpback whales sing.", ["/guides/a"]],
  ["/guides/a", "Tides", "Tides rise and fall.", ["/guides/b"]],
  ["/guides/b", "Currents", "Currents move water.", ["/guides/c"]],
  ["/guides/c", "Reefs", "Reefs shelter fish.", ["/guides/whale-song"]],
  ["/guides/whale-song", "Whale song", "Humpback whales sing.", []],
];

let pool: pg.Pool;
let db: q.Queryable;
let runId: number;

beforeAll(async () => {
  pool = createPool(inject("databaseUrl"));
  db = asQueryable(pool);
  const site = await q.insertSite(db, { rootUrl: `${S}/` });
  runId = (await q.createRun(db, { siteId: site.id, config })).id;
  for (const [path, title, body, links] of PAGES) {
    const f = await q.insertFetch(db, {
      runId,
      requestedUrl: S + path,
      finalUrl: S + path,
      statusCode: 200,
      contentType: "text/html",
    });
    await q.insertPage(db, { runId, fetchId: f.id, url: S + path, title, bodyText: body });
    await q.insertLinkObservations(db, [
      ...links.map((l, i) => ({
        runId,
        sourceFetchId: f.id,
        rawHref: l,
        resolvedUrl: S + l,
        domRegion: "main",
        positionIndex: i,
      })),
      ...(path === "/"
        ? []
        : [
            {
              runId,
              sourceFetchId: f.id,
              rawHref: "/",
              resolvedUrl: `${S}/`,
              domRegion: "nav",
              positionIndex: 99,
            },
          ]),
    ]);
  }
});
afterAll(async () => {
  await pool.end();
});

const strip = (rs: readonly TimedResult[]) => rs.map(({ runtimeMs: _, ...r }) => r);

describe("counterfactual engine", () => {
  let report: Awaited<ReturnType<typeof buildCounterfactualRun>>;

  it("simulates every fix candidate in worker threads and stores the artefact", async () => {
    report = await buildCounterfactualRun(db, runId, "P0", { workers: 2 });
    const { list } = await fixes.loadCandidates(db, runId, "P0");
    expect(list.candidates.length).toBeGreaterThan(0);
    expect(report.results.map((r) => r.candidateId)).toEqual(list.candidates.map((c) => c.id));
    expect(report.artefact).toMatchObject({
      runId,
      policyVersion: "P0@1.0.0",
      kind: "counterfactual",
    });
    expect(report).toMatchObject({
      version: "counterfactual@1.0.0",
      params: { pagerankDamping: 0.85, bodyWeight: 1, warmStart: true },
      baseline: { nodes: 6, seed: `${S}/`, converged: true },
    });
    expect(report.stats.converged).toBe(report.results.length);
  });

  it("measures ΔPR_v, the site-wide L1 change and Δdepth_v for the hub → whale-song link", () => {
    const r = report.results.find(
      (x) => x.donor === `${S}/guides/` && x.target === `${S}/guides/whale-song`,
    );
    expect(r).toMatchObject({
      action: "add-link",
      weightBefore: 0,
      weightAfter: 1,
      depthBefore: 5,
      depthAfter: 2,
      deltaDepth: -3,
    });
    expect(r?.deltaPrTarget).toBeGreaterThan(0);
    expect(r?.deltaPrL1).toBeGreaterThanOrEqual(r?.deltaPrTarget ?? Infinity);
  });

  it("checks the warm start against a cold start on a seeded sample", () => {
    expect(report.validation.sample.length).toBe(Math.min(5, report.results.length));
    expect(report.validation.passed).toBe(true);
    expect(report.validation.maxL1Difference).toBeLessThanOrEqual(report.validation.tolerance);
  });

  it("reports the runtime per candidate", () => {
    for (const r of report.results) expect(r.runtimeMs).toBeGreaterThanOrEqual(0);
    const t = report.runtime.perCandidateMs;
    expect(t.max).toBeGreaterThanOrEqual(t.p95);
    expect(t.p95).toBeGreaterThanOrEqual(t.p50);
    expect(report.runtime.workers).toBeGreaterThanOrEqual(1);
    expect(report.runtime.wallMs).toBeGreaterThan(0);
  });

  it("gives identical results (timing aside) with a different number of workers", async () => {
    const again = await buildCounterfactualRun(db, runId, "P0", { workers: 1 });
    expect(strip(again.results)).toEqual(strip(report.results));
    expect(again.validation).toEqual(report.validation);
  });
});
