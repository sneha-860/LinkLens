import { describe, expect, it } from "vitest";
import { makeConfig } from "@linklens/core";
import { learnedPayload } from "./evaluate.js";
import {
  CATEGORICAL_FEATURES,
  FEATURES,
  NUMERIC_FEATURES,
  detachedFacts,
  jaccardOf,
  pairFeatures,
  sScore,
  type NodeFacts,
} from "./features.js";

const config = makeConfig();
const facts = (over: Partial<NodeFacts> = {}): NodeFacts => ({
  pagerank: 0.01,
  depth: 2,
  inNeighbours: 3,
  outNeighbours: 4,
  inLargestScc: true,
  type: "article",
  importance: 0.5,
  ...over,
});
const base = {
  donor: "https://s.test/blog/a",
  target: "https://s.test/blog/b",
  deltaPr: 0.002,
  depthBefore: 4,
  depthAfter: 2,
  ref: 0.4,
  cosine: 0.7,
  jaccard: 0.1,
  omega: 0,
  kappa: 2,
  templateReach: 5,
  donorFacts: facts({ type: "hub", importance: 0.8 }),
  targetFacts: facts({ depth: 4, inLargestScc: false }),
};

describe("pairFeatures", () => {
  it("fills every feature, numeric and categorical", () => {
    const f = pairFeatures(base);
    expect(Object.keys(f).sort()).toEqual([...FEATURES].sort());
    expect(f).toMatchObject({
      delta_pr: 0.002,
      depth_gain: 2,
      newly_reachable: 0,
      ref: 0.4,
      cosine: 0.7,
      kappa: 2,
      template_reach: 5,
      donor_type: "hub",
      target_type: "article",
      donor_importance: 0.8,
      target_in_scc: 0,
      donor_in_scc: 1,
      same_section: 1,
    });
    expect(NUMERIC_FEATURES.length + CATEGORICAL_FEATURES.length).toBe(FEATURES.length);
  });

  it("marks a page that becomes reachable, and leaves unknown values null", () => {
    const f = pairFeatures({ ...base, depthBefore: null, depthAfter: 3, cosine: null });
    expect(f).toMatchObject({ newly_reachable: 1, depth_gain: null, cosine: null });
    const g = pairFeatures({ ...base, target: "https://s.test/docs/x" });
    expect(g.same_section).toBe(0);
  });
});

describe("helpers", () => {
  it("computes Jaccard of the two views", () => {
    expect(jaccardOf(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
    expect(jaccardOf(new Set(), new Set())).toBe(0);
  });

  it("scores S with the REF-gated cosine, the baseline", () => {
    expect(sScore(0.01, 0.5, 0.8, 2, config)).toBeCloseTo((0.01 * 0.8) / 2, 15);
    // REF not above ε: σ = 0.
    expect(sScore(0.01, 0.1, 0.8, 2, config)).toBe(0);
    expect(sScore(0.01, 0.5, null, 2, config)).toBe(0);
  });

  it("gives an orphan detached facts (no links, unreachable, URL type)", () => {
    const f = detachedFacts("https://s.test/products/red-mug", 0.0001, config);
    expect(f).toMatchObject({
      depth: null,
      inNeighbours: 0,
      inLargestScc: false,
      type: "product",
      pagerank: 0.0001,
    });
    expect(f.importance).toBeGreaterThan(0);
  });

  it("builds the learned-priority payload from a site's predictions", () => {
    const p = learnedPayload(
      {
        site: "a",
        runId: 7,
        trainedOn: ["b", "c"],
        labels: "e6",
        features: ["delta_pr"],
        params: { num_leaves: 15 },
        dataset: "abc",
        createdAt: "2026-01-01T00:00:00Z",
        fixes: { f1: { priority: 0.9, raw: 1, shap: [] } },
        pool: {},
      },
      "P3@1.0.0",
    );
    expect(p).toMatchObject({
      version: "learned@1.0.0",
      runId: 7,
      policyVersion: "P3@1.0.0",
      model: { site: "a", trainedOn: ["b", "c"] },
      fixes: { f1: { priority: 0.9 } },
    });
  });
});
