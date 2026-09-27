import { describe, expect, it } from "vitest";
import type { PolicyId } from "../canonicalise/index.js";
import { comparePolicyPair, comparePolicyPairs } from "./pairwise.js";
import { sensitivityFromSnapshots, type PolicySnapshot } from "./sensitivity.js";

function snap(policy: PolicyId, over: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    policy,
    policyVersion: `${policy}@1.0.0`,
    nodes: 4,
    edges: 5,
    reachable: 3,
    largestScc: 3,
    issues: 2,
    meanDepth: 1,
    orphanCount: 1,
    orphans: new Set(["o"]),
    pagerank: new Map([
      ["a", 0.4],
      ["b", 0.3],
      ["c", 0.2],
      ["o", 0.1],
    ]),
    depth: new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]),
    topFixes: new Set(["a -> o", "b -> c"]),
    fixCount: 2,
    ...over,
  };
}

describe("comparePolicyPair", () => {
  it("agrees perfectly with itself", () => {
    expect(comparePolicyPair(snap("P0"), snap("P1"))).toEqual({
      a: "P0",
      b: "P1",
      nodesA: 4,
      nodesB: 4,
      nodeDelta: 0,
      nodeRatio: 1,
      sharedNodes: 4,
      nodeJaccard: 1,
      orphansA: 1,
      orphansB: 1,
      orphanJaccard: 1,
      pagerankSpearman: 1,
      depthPages: 3,
      meanDepthShift: 0,
      meanAbsDepthShift: 0,
      maxAbsDepthShift: 0,
      topFixesJaccard: 1,
    });
  });

  it("measures differences as b − a over what both share", () => {
    const b = snap("P4", {
      nodes: 3,
      orphans: new Set(["o", "p"]),
      // "c" merged away; the rest reordered.
      pagerank: new Map([
        ["a", 0.1],
        ["b", 0.5],
        ["o", 0.4],
      ]),
      depth: new Map([
        ["a", 0],
        ["b", 3],
        ["o", 1],
      ]),
      topFixes: new Set(["a -> o", "b -> o"]),
    });
    const c = comparePolicyPair(snap("P3"), b);
    expect(c).toMatchObject({
      nodeDelta: -1,
      nodeRatio: 0.75,
      sharedNodes: 3,
      nodeJaccard: 0.75,
      orphansB: 2,
      orphanJaccard: 0.5,
      depthPages: 2, // a and b (o is unreachable under P3)
      meanDepthShift: 1,
      meanAbsDepthShift: 1,
      maxAbsDepthShift: 2,
      topFixesJaccard: 1 / 3,
    });
    expect(c.pagerankSpearman).toBeCloseTo(-0.5); // a,b,o: 3,2,1 vs 1,3,2
  });

  it("leaves what cannot be computed null", () => {
    const c = comparePolicyPair(
      snap("P0", { nodes: 0, pagerank: new Map(), depth: new Map(), topFixes: null }),
      snap("P1"),
    );
    expect(c).toMatchObject({
      nodeRatio: null,
      sharedNodes: 0,
      nodeJaccard: 0,
      pagerankSpearman: null,
      depthPages: 0,
      meanDepthShift: null,
      maxAbsDepthShift: null,
      topFixesJaccard: null,
    });
  });
});

describe("comparePolicyPairs", () => {
  it("compares every unordered pair once, in policy order", () => {
    const ids: PolicyId[] = ["P0", "P1", "P2", "P3", "P4", "P5"];
    const r = comparePolicyPairs({
      runId: 7,
      sigma: "refGateCosine",
      k: 10,
      snapshots: ids.map((p) => snap(p)),
    });
    expect(r.pairs).toHaveLength(15);
    expect(r.pairs.slice(0, 6).map((p) => `${p.a}-${p.b}`)).toEqual([
      "P0-P1",
      "P0-P2",
      "P0-P3",
      "P0-P4",
      "P0-P5",
      "P1-P2",
    ]);
    expect(r.pairs.at(-1)).toMatchObject({ a: "P4", b: "P5" });
    expect(r).toMatchObject({ runId: 7, k: 10 });
  });
});

describe("sensitivityFromSnapshots", () => {
  it("compares each policy with the baseline and keeps the policy's own orphan count", () => {
    const r = sensitivityFromSnapshots(
      {
        runId: 1,
        sigma: "refGateCosine",
        k: 10,
        snapshots: [snap("P0", { orphanCount: 2 }), snap("P3", { topFixes: null })],
      },
      "P3",
    );
    expect(
      r.policies.map((p) => [p.policy, p.orphans, p.pagerankSpearman, p.topFixesJaccard]),
    ).toEqual([
      ["P0", 2, 1, null],
      ["P3", 1, 1, null],
    ]);
    expect(() =>
      sensitivityFromSnapshots({ runId: 1, sigma: "refGateCosine", k: 1, snapshots: [] }, "P3"),
    ).toThrow(/baseline/);
  });
});
