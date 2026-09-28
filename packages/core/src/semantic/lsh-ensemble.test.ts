import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import { mulberry32 } from "../graph/random.js";
import { buildTextModel } from "../text/model.js";
import {
  buildLshEnsemble,
  collisionProbability,
  fmix32,
  hashTerm,
  minhash,
  optimalBands,
  hashFamily,
  queryLshEnsemble,
  type LshParams,
} from "./lsh-ensemble.js";
import {
  candidatesByDonor,
  lshCandidates,
  lshParams,
  prepareRef,
  refMatrix,
  refMatrixPrepared,
} from "./ref.js";
import { syntheticSite } from "./synthetic.js";

const params: LshParams = {
  numPerm: 128,
  partitions: 4,
  maxRows: 16,
  falsePositiveWeight: 0.5,
  falseNegativeWeight: 0.5,
  seed: 42,
};

/** k distinct random 32-bit values. */
function randomSet(k: number, random: () => number): number[] {
  const s = new Set<number>();
  while (s.size < k) s.add(Math.floor(random() * 4294967296) >>> 0);
  return [...s];
}

describe("hashing and MinHash", () => {
  it("is deterministic and spreads terms", () => {
    expect(hashTerm("turtl nest")).toBe(hashTerm("turtl nest"));
    expect(hashTerm("turtl nest")).not.toBe(hashTerm("turtl nesu"));
    expect(fmix32(0)).toBe(0);
    const hs = new Set(Array.from({ length: 10_000 }, (_, i) => hashTerm(`term${i}`)));
    expect(hs.size).toBe(10_000);
    expect([...hashFamily(4, 7).tables]).toEqual([...hashFamily(4, 7).tables]);
    expect([...hashFamily(4, 7).tables]).not.toEqual([...hashFamily(4, 8).tables]);
  });

  it("estimates Jaccard similarity (share of equal minima)", () => {
    const random = mulberry32(1);
    const seeds = hashFamily(256, 42);
    const shared = randomSet(300, random);
    const a = [...shared, ...randomSet(200, random)];
    const b = [...shared, ...randomSet(100, random)];
    const truth = 300 / 600;
    const [sa, sb] = [minhash(a, seeds), minhash(b, seeds)];
    let equal = 0;
    for (let i = 0; i < 256; i++) if (sa[i] === sb[i]) equal += 1;
    // Standard error √(J(1 − J)/256) ≈ 0.031.
    expect(Math.abs(equal / 256 - truth)).toBeLessThan(0.1);
    expect([...minhash([], seeds)].every((x) => x === 0xffffffff)).toBe(true);
  });
});

describe("optimalBands", () => {
  it("respects b·r ≤ numPerm and r ≤ maxRows", () => {
    for (const t of [0.05, 0.2, 0.5, 0.9]) {
      for (const ratio of [0.01, 0.2, 1, 5]) {
        const { b, r } = optimalBands(t, ratio, params);
        expect(b * r).toBeLessThanOrEqual(params.numPerm);
        expect(r).toBeLessThanOrEqual(params.maxRows);
        expect(b).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("puts the steep part of the S-curve near the threshold", () => {
    // Query as large as the partition's sets (ratio 1): containment x ↔ Jaccard x / (2 − x).
    const j = (x: number) => x / (2 - x);
    for (const t of [0.3, 0.6]) {
      const bands = optimalBands(t, 1, params);
      expect(collisionProbability(j(Math.min(1, t + 0.3)), bands)).toBeGreaterThan(0.9);
      expect(collisionProbability(j(Math.max(0, t - 0.25)), bands)).toBeLessThan(0.5);
    }
    // A higher threshold never uses a looser scheme at the lower threshold's point.
    const lo = optimalBands(0.2, 1, params);
    const hi = optimalBands(0.8, 1, params);
    expect(collisionProbability(j(0.2), hi)).toBeLessThanOrEqual(collisionProbability(j(0.2), lo));
  });
});

describe("LSH Ensemble", () => {
  // Indexed sets of very different sizes; each query is contained in some of them.
  const random = mulberry32(7);
  const sizes = [20, 50, 100, 200, 400, 800];
  const indexed: number[][] = [];
  const queries: { q: number[]; contains: Map<number, number> }[] = [];
  for (let i = 0; i < 12; i++) {
    const q = randomSet(40, random);
    const contains = new Map<number, number>();
    for (const size of sizes) {
      // One set holding 80% of q, one holding 10%, padded to `size`.
      for (const share of [0.8, 0.1]) {
        const keep = q.slice(0, Math.round(share * q.length));
        const set = [...keep, ...randomSet(Math.max(size - keep.length, 0), random)];
        contains.set(indexed.length, keep.length / q.length);
        indexed.push(set);
      }
    }
    queries.push({ q, contains });
  }
  const index = buildLshEnsemble(indexed, params);

  it("partitions by size, equi-depth", () => {
    expect(index.partitions).toHaveLength(4);
    const counts = index.partitions.map((p) => p.ids.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    for (let i = 1; i < index.partitions.length; i++) {
      expect(index.partitions[i]?.lower).toBeGreaterThanOrEqual(
        index.partitions[i - 1]?.upper as number,
      );
    }
  });

  it("finds sets that contain the query above the threshold, across set sizes", () => {
    let found = 0;
    let wanted = 0;
    let lowReturned = 0;
    let low = 0;
    for (const { q, contains } of queries) {
      const hits = new Set(queryLshEnsemble(index, minhash(q, index.family), q.length, 0.5));
      for (const [id, c] of contains) {
        if (c >= 0.5) {
          wanted += 1;
          if (hits.has(id)) found += 1;
        } else {
          low += 1;
          if (hits.has(id)) lowReturned += 1;
        }
      }
    }
    expect(found / wanted).toBeGreaterThanOrEqual(0.9);
    // Containment 0.1 is well below 0.5: most of those are filtered out.
    expect(lowReturned / low).toBeLessThan(0.5);
  });

  it("skips partitions whose sets are too small to contain the query", () => {
    const big = randomSet(2_000, mulberry32(3));
    // Every indexed set has ≤ 800 terms < 0.5 × 2000: nothing can qualify.
    expect(queryLshEnsemble(index, minhash(big, index.family), big.length, 0.5)).toEqual([]);
    expect(queryLshEnsemble(index, minhash([], index.family), 0, 0.5)).toEqual([]);
  });

  it("is deterministic for a seed", () => {
    const again = buildLshEnsemble(indexed, params);
    for (const { q } of queries) {
      expect(queryLshEnsemble(again, minhash(q, again.family), q.length, 0.3)).toEqual(
        queryLshEnsemble(index, minhash(q, index.family), q.length, 0.3),
      );
    }
  });
});

// Builds three 120-page models: fast alone, but slow when the whole workspace runs in parallel.
describe("REF with the LSH Ensemble pre-filter", { timeout: 30_000 }, () => {
  // No boilerplate drop, so pages share terms: with 200 words about 20% of the pairs have a
  // weighted REF > ε; with 400 words about 12% have an unweighted one (not a trivial recall).
  const config = makeConfig({ epsilon: 0.2, frequentNgramDropPct: 0 });
  const site = (vocabulary: number) =>
    buildTextModel(
      {
        runId: 1,
        policyVersion: "P0@1.0.0",
        documents: syntheticSite({ pages: 120, vocabulary, bodyWords: 120, anchors: 10, seed: 5 }),
      },
      config,
    );
  const model = site(200);
  const key = (e: { source: number; target: number }) => `${e.source}:${e.target}`;

  it("scores candidates exactly: with every pair as a candidate it equals the exact matrix", () => {
    for (const variant of ["weighted", "unweighted"] as const) {
      const prep = prepareRef(model, variant);
      const n = prep.docs.length;
      const all = Array.from({ length: n }, (_, v) =>
        Array.from({ length: n }, (_, u) => u).filter((u) => u !== v),
      );
      const { byDonor, pairs } = candidatesByDonor(all, n);
      expect(pairs).toBe(n * (n - 1));
      const exact = refMatrixPrepared(prep, config);
      const viaCandidates = refMatrixPrepared(prep, config, byDonor);
      expect(viaCandidates.entries).toEqual(exact.entries);
      expect(viaCandidates.stats).toEqual(exact.stats);
    }
  });

  it("returns a subset of the exact entries, with the same scores, and records how", () => {
    const exact = refMatrix(model, "weighted", config);
    const lsh = refMatrix(model, "weighted", { ...config, refPrefilter: "lsh-ensemble" });
    const truth = new Map(exact.entries.map((e) => [key(e), e.ref]));
    expect(lsh.entries.length).toBeGreaterThan(0);
    for (const e of lsh.entries) expect(truth.get(key(e))).toBe(e.ref);
    expect(exact.prefilter).toBeNull();
    expect(lsh.prefilter).toMatchObject({
      method: "lsh-ensemble",
      threshold: config.lshThreshold,
      numPerm: config.lshNumPerm,
      partitions: config.lshPartitions,
      maxRows: config.lshMaxRows,
    });
    expect(lsh.prefilter?.candidates).toBeLessThanOrEqual(exact.stats.pairs);
    // ρ is renormalised over the entries that were found.
    const rows = new Map<number, number>();
    for (const e of lsh.entries) rows.set(e.source, (rows.get(e.source) ?? 0) + e.rho);
    for (const s of rows.values()) expect(s).toBeCloseTo(1, 12);
  });

  it("recalls the unweighted REF > ε pairs at a lower containment threshold", () => {
    const sparse = site(400);
    const exact = refMatrix(sparse, "unweighted", config);
    expect(exact.entries.length / exact.stats.pairs).toBeLessThan(0.2);
    const prep = prepareRef(sparse, "unweighted");
    const { byDonor } = lshCandidates(prep, lshParams(config), 0.1);
    const found = new Set(refMatrixPrepared(prep, config, byDonor).entries.map(key));
    const recall = exact.entries.filter((e) => found.has(key(e))).length / exact.entries.length;
    expect(exact.entries.length).toBeGreaterThan(0);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});
