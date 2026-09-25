import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { db as q, makeConfig, semantic } from "@linklens/core";
import { asQueryable, createPool } from "@linklens/db";
import {
  EmbeddingWorker,
  buildCosineRun,
  embeddingOptions,
  type EmbeddingOptions,
} from "../src/index.js";

// Model files are kept between runs (downloaded once, ~90 MB); embeddings go to a fresh dir.
const MODEL_DIR = fileURLToPath(new URL("../.cache/models", import.meta.url));
const config = makeConfig({ userAgent: "LinkLensBot/0.1 (+https://linklens.test/bot)" });
const S = "https://fixture.test";

// A tiny site: two pages about whales, one about baking, and a home page linking to them.
const PAGES: [string, string, string][] = [
  ["/", "Home", "Welcome to the fixture site."],
  [
    "/whales/blue",
    "Blue whale",
    "The blue whale is the largest animal on Earth. It feeds on krill in the open ocean.",
  ],
  [
    "/whales/humpback",
    "Humpback whale",
    "Humpback whales sing long songs and migrate thousands of kilometres across the ocean.",
  ],
  [
    "/baking/cake",
    "Chocolate cake",
    "Mix flour, sugar, cocoa and eggs, then bake the cake for thirty minutes.",
  ],
];

let pool: pg.Pool;
let db: q.Queryable;
let cacheDir: string;
let runId: number;
const options = (o: Partial<EmbeddingOptions> = {}): EmbeddingOptions => ({
  ...embeddingOptions(config, cacheDir),
  modelDir: MODEL_DIR,
  ...o,
});

beforeAll(async () => {
  pool = createPool(inject("databaseUrl"));
  db = asQueryable(pool);
  cacheDir = await mkdtemp(join(tmpdir(), "linklens-emb-int-"));
  const site = await q.insertSite(db, { rootUrl: `${S}/` });
  const run = await q.createRun(db, { siteId: site.id, config });
  runId = run.id;
  for (const [path, title, body] of PAGES) {
    const f = await q.insertFetch(db, {
      runId,
      requestedUrl: S + path,
      finalUrl: S + path,
      statusCode: 200,
      contentType: "text/html",
    });
    const page = await q.insertPage(db, {
      runId,
      fetchId: f.id,
      url: S + path,
      title,
      bodyText: body,
    });
    if (path === "/") {
      await q.insertLinkObservations(
        db,
        PAGES.slice(1).map(([p], i) => ({
          runId,
          sourceFetchId: page.fetchId,
          rawHref: p,
          resolvedUrl: S + p,
          domRegion: "main",
          positionIndex: i,
        })),
      );
    }
  }
});
afterAll(async () => {
  await pool.end();
  await rm(cacheDir, { recursive: true, force: true });
});

describe("semantic engine (all-MiniLM-L6-v2 in a worker thread)", () => {
  let first: Awaited<ReturnType<typeof buildCosineRun>>;

  it("does not block the caller's event loop while the worker loads the model and embeds", async () => {
    const worker = EmbeddingWorker.start(options());
    try {
      let last = performance.now();
      let maxGap = 0;
      let ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks += 1;
      }, 10);
      const started = performance.now();
      first = await buildCosineRun(db, runId, "P0", worker);
      const elapsed = performance.now() - started;
      clearInterval(timer);
      // The timer kept firing throughout (model load + inference happen off the main thread).
      expect(ticks).toBeGreaterThan(elapsed / 10 / 4);
      expect(maxGap).toBeLessThan(250);
    } finally {
      await worker.close();
    }
  });

  it("stores 384-d mean-pooled embeddings' cosines for every pair of pages", async () => {
    expect(first).toMatchObject({
      version: "cosine@1.0.0",
      runId,
      policyVersion: "P0@1.0.0",
      model: "Xenova/all-MiniLM-L6-v2",
      dtype: "fp32",
      bodyTokens: 256,
      dimensions: 384,
      cache: { hits: 0, misses: 4 },
    });
    expect(first.nodes).toEqual([
      `${S}/`,
      `${S}/baking/cake`,
      `${S}/whales/blue`,
      `${S}/whales/humpback`,
    ]);
    expect(first.upper).toHaveLength(6);
    const cos = (a: string, b: string) => semantic.cosineOf(first, S + a, S + b) as number;
    // Observed: whale–whale ≈ 0.44; every other pair within ±0.06.
    const whales = cos("/whales/blue", "/whales/humpback");
    expect(whales).toBeGreaterThan(0.3);
    const others = first.upper.filter((x) => x !== whales);
    expect(others).toHaveLength(5);
    for (const x of others) expect(Math.abs(x)).toBeLessThan(0.2);
    expect(cos("/whales/humpback", "/whales/blue")).toBe(whales);
    for (const x of first.upper) expect(Math.abs(x)).toBeLessThanOrEqual(1 + 1e-6);
    const stored = await q.listArtefacts(db, runId, { kind: "cosine-matrix" });
    expect((stored[0]?.payload as unknown as semantic.CosineMatrix).upper).toEqual(first.upper);
  });

  it("re-runs from the disk cache (a new worker) with identical results", async () => {
    const worker = EmbeddingWorker.start(options());
    try {
      const again = await buildCosineRun(db, runId, "P0", worker);
      expect(again.cache).toEqual({ hits: 4, misses: 0 });
      expect(again.contentKeys).toEqual(first.contentKeys);
      expect(again.upper).toEqual(first.upper);
    } finally {
      await worker.close();
    }
  });

  it("returns unit-length vectors and embeds only the first N body tokens", async () => {
    const worker = EmbeddingWorker.start(options({ bodyTokens: 8 }));
    try {
      const head = "the blue whale is the largest animal on";
      const r = await worker.embed([
        { title: "Blue whale", body: `${head} earth and eats krill.` },
        { title: "Blue whale", body: `${head} a diet of tiny shrimp, sadly.` },
        { title: "Blue whale", body: "a completely different body about baking bread." },
      ]);
      expect(r.dimensions).toBe(384);
      for (const v of r.vectors) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
      // Same title and same first 8 body tokens: the tails beyond N are not embedded.
      expect(r.vectors[1]).toEqual(r.vectors[0]);
      expect(r.vectors[2]).not.toEqual(r.vectors[0]);
      expect(new Set(r.keys).size).toBe(3); // distinct content, distinct cache keys
    } finally {
      await worker.close();
    }
  });

  it("refuses an embedder whose settings differ from the run's config", async () => {
    const worker = EmbeddingWorker.start(options({ bodyTokens: 64 }));
    try {
      await expect(buildCosineRun(db, runId, "P0", worker)).rejects.toThrow(/does not match/);
    } finally {
      await worker.close();
    }
  });

  it("rejects pending and later requests once closed", async () => {
    const worker = EmbeddingWorker.start(options());
    await worker.close();
    await expect(worker.embed([{ title: "x", body: "" }])).rejects.toThrow(/closed/);
  });
});
