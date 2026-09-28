import { describe, expect, it } from "vitest";
import { makeConfig, semantic, text } from "@linklens/core";
import {
  LSH_COLUMNS,
  admissionRanks,
  bruteForceRef,
  capDocuments,
  evaluateCap,
  lshRows,
} from "./lsh-prefilter.js";

const S = "https://site.test";
// Six topics, three pages each, plus shared words: pages about the same topic contain each other.
const TOPICS = [
  "whale song",
  "turtle nesting",
  "coral reef",
  "shark teeth",
  "kelp forest",
  "tide pool",
];
const docs: text.RawDocument[] = TOPICS.flatMap((topic, t) =>
  [0, 1, 2].map((i) => {
    const n = t * 3 + i;
    return {
      node: `${S}/p${String(n).padStart(2, "0")}`,
      fetchId: n + 1,
      url: `${S}/p${n}`,
      title: [`${topic} guide ${["one", "two", "three"][i]}`],
      links: [`more on ${topic}`],
      body: [`All about ${topic}. The ${topic} of the ocean. Ocean wildlife notes.`],
    };
  }),
);
const config = makeConfig({
  epsilon: 0.2,
  frequentNgramDropPct: 0,
  lshEvalRepeats: 1,
  lshEvalThresholds: [0.05, 0.1, 0.2],
});

describe("caps", () => {
  it("rank URLs by first crawl attempt, ignoring retries and other purposes", () => {
    const rank = admissionRanks([
      { id: 3, requestedUrl: "b", purpose: "crawl" },
      { id: 1, requestedUrl: "robots", purpose: "robots" },
      { id: 2, requestedUrl: "a", purpose: "crawl" },
      { id: 4, requestedUrl: "a", purpose: "crawl" },
      { id: 5, requestedUrl: "c", purpose: "discovery" },
    ]);
    expect([...rank]).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("keep the documents whose page was among the first N admitted", () => {
    const rank = new Map(docs.map((d, i) => [d.node, i]));
    expect(capDocuments(docs, rank, 4).map((d) => d.node)).toEqual(
      docs.slice(0, 4).map((d) => d.node),
    );
    expect(capDocuments(docs, rank, 100)).toHaveLength(docs.length);
  });
});

describe("brute force", () => {
  it("agrees with the exact inverted index, pair for pair", () => {
    const model = text.buildTextModel(
      { runId: 1, policyVersion: "P0@1.0.0", documents: docs },
      config,
    );
    for (const variant of semantic.REF_VARIANTS) {
      const exact = semantic.refMatrix(model, variant, config);
      const brute = bruteForceRef(model, variant, config.epsilon);
      expect(exact.entries.length).toBeGreaterThan(0);
      expect(brute.size).toBe(exact.entries.length);
      for (const e of exact.entries)
        expect(brute.get(`${e.source}:${e.target}`)).toBeCloseTo(e.ref, 12);
    }
  });
});

describe("evaluateCap", () => {
  const r = evaluateCap(docs, 18, { runId: 1, policyVersion: "P0@1.0.0" }, config);

  it("reports every variant and threshold, with recall against exact REF", () => {
    expect(r).toMatchObject({ cap: 18, documents: 18, pairs: 18 * 17 });
    expect(r.variants.map((v) => v.variant)).toEqual(["weighted", "unweighted"]);
    for (const v of r.variants) {
      expect(v.bruteForceMatches).toBe(true);
      expect(v.truePairs).toBeGreaterThan(0);
      expect(v.thresholds.map((t) => t.threshold)).toEqual([0.05, 0.1, 0.2]);
      for (const t of v.thresholds) {
        expect(t.found).toBeLessThanOrEqual(v.truePairs);
        expect(t.recall).toBe(t.found / v.truePairs);
        expect(t.candidateShare).toBe(t.candidates / r.pairs);
        for (const x of [t.recall, t.massRecall, t.topRecall, t.precision]) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1);
        }
        expect(t.ms.total).toBeGreaterThanOrEqual(t.ms.query + t.ms.verify);
      }
      // The loosest threshold finds every true (same-topic) pair on this small site.
      expect(v.thresholds[0]?.recall).toBe(1);
    }
  });

  it("gives one tidy row per metric, never an empty value", () => {
    const rows = lshRows({ siteId: "s", runId: 1, policyVersion: "P0@1.0.0" }, r);
    expect(Object.keys(rows[0] ?? {})).toEqual([...LSH_COLUMNS]);
    expect(rows.every((x) => x.value !== null && Number.isFinite(x.value))).toBe(true);
    const metrics = new Set(rows.map((x) => x.metric));
    for (const m of [
      "pairs",
      "ms_index",
      "true_pairs",
      "ms_exact",
      "ms_brute_force",
      "recall",
      "ms_lsh_total",
    ]) {
      expect(metrics.has(m)).toBe(true);
    }
    const noBrute = evaluateCap(docs, 18, { runId: 1, policyVersion: "P0@1.0.0" }, config, {
      variants: ["weighted"],
      bruteForce: false,
    });
    const rows2 = lshRows({ siteId: "s", runId: 1, policyVersion: "P0@1.0.0" }, noBrute);
    expect(rows2.some((x) => x.metric === "ms_brute_force")).toBe(false);
  });
});

// LINKLENS_WRITE_FIXTURES=1 writes analysis/tests/fixtures/lsh/ (two sites, three caps), so
// analysis/linklens_analysis/lsh.py is tested on the real shape.
describe.runIf(process.env["LINKLENS_WRITE_FIXTURES"] === "1")("analysis fixture", () => {
  it("writes lsh.csv and lsh.json", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { toCsv } = await import("./corpus/csv.js");
    const dir = fileURLToPath(new URL("../../../analysis/tests/fixtures/lsh/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    const rows = [];
    for (const [siteId, order] of [
      ["ocean", docs],
      ["reef", [...docs].reverse()],
    ] as const) {
      const r = new Map(order.map((d, i) => [d.node, i]));
      for (const cap of [6, 12, 18]) {
        const result = evaluateCap(
          capDocuments(docs, r, cap),
          cap,
          { runId: 1, policyVersion: "P3@1.0.0" },
          config,
        );
        rows.push(
          ...lshRows(
            { siteId, runId: siteId === "ocean" ? 1 : 2, policyVersion: "P3@1.0.0" },
            result,
          ),
        );
      }
    }
    writeFileSync(`${dir}lsh.csv`, toCsv(LSH_COLUMNS, rows), "utf8");
    writeFileSync(
      `${dir}lsh.json`,
      `${JSON.stringify(
        {
          experiment: "fixture",
          threshold: 0.1,
          thresholds: config.lshEvalThresholds,
          caps: [6, 12, 18],
          epsilon: config.epsilon,
          repeats: config.lshEvalRepeats,
          params: semantic.lshParams(config),
          host: { cpu: "fixture" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });
});
