import { describe, expect, it } from "vitest";
import { averageRanks, depthShift, jaccard, rankingMetrics, spearman } from "./stats.js";

describe("jaccard", () => {
  it("is |A ∩ B| / |A ∪ B|, and 1 for two empty sets", () => {
    expect(jaccard(new Set([1, 2, 3]), new Set([2, 3, 4]))).toBe(0.5);
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set([1]), new Set())).toBe(0);
  });
});

describe("averageRanks", () => {
  it("gives ties their average rank", () => {
    expect(averageRanks([10, 20, 20, 5])).toEqual([2, 3.5, 3.5, 1]);
  });
});

describe("spearman", () => {
  const m = (entries: [string, number][]) => new Map(entries);
  it("is 1 for the same order, −1 for the reverse", () => {
    expect(
      spearman(
        m([
          ["a", 1],
          ["b", 2],
          ["c", 3],
        ]),
        m([
          ["a", 10],
          ["b", 20],
          ["c", 30],
        ]),
      ),
    ).toBeCloseTo(1, 12);
    expect(
      spearman(
        m([
          ["a", 1],
          ["b", 2],
          ["c", 3],
        ]),
        m([
          ["a", 3],
          ["b", 2],
          ["c", 1],
        ]),
      ),
    ).toBeCloseTo(-1, 12);
  });

  it("uses only the common keys and handles ties", () => {
    const r = spearman(
      m([
        ["a", 1],
        ["b", 2],
        ["c", 2],
        ["x", 9],
      ]),
      m([
        ["a", 1],
        ["b", 3],
        ["c", 2],
        ["y", 0],
      ]),
    );
    expect(r).toBeCloseTo(0.866025, 5);
  });

  it("is null with fewer than two common keys or no variation", () => {
    expect(spearman(m([["a", 1]]), m([["a", 1]]))).toBeNull();
    expect(
      spearman(
        m([
          ["a", 1],
          ["b", 1],
        ]),
        m([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    ).toBeNull();
  });
});

describe("depthShift", () => {
  it("averages signed and absolute shifts over pages in both", () => {
    const r = depthShift(
      new Map([
        ["a", 1],
        ["b", 4],
        ["z", 2],
      ]),
      new Map([
        ["a", 2],
        ["b", 2],
        ["y", 1],
      ]),
    );
    expect(r).toEqual({ mean: 0.5, meanAbs: 1.5, pages: 2 });
    expect(depthShift(new Map([["a", 1]]), new Map())).toBeNull();
  });
});

describe("rankingMetrics", () => {
  it("gives MRR and recall@k from 1-based ranks (null = not found)", () => {
    const m = rankingMetrics([1, 3, null, 2], [1, 3]);
    expect(m.n).toBe(4);
    expect(m.mrr).toBeCloseTo((1 + 1 / 3 + 0 + 1 / 2) / 4, 12);
    expect(m.recall).toEqual({ 1: 0.25, 3: 0.75 });
    expect(rankingMetrics([], [1])).toEqual({ n: 0, mrr: null, recall: { 1: null } });
  });
});
