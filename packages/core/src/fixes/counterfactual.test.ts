import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import { pagerank, type Collapsed } from "../graph/metrics.js";
import { mulberry32 } from "../graph/random.js";
import {
  baseline,
  depthFromSeed,
  linkWeight,
  simulate,
  validateWarmStart,
  weightedGraph,
  weightedPagerank,
  withLink,
  workspace,
  type Scenario,
  type WeightedGraph,
} from "./counterfactual.js";

const config = makeConfig();
const sum = (xs: Float64Array) => xs.reduce((s, x) => s + x, 0);
const L = (source: string, target: string, weight = 1) => ({ source, target, weight });

describe("weightedGraph / withLink", () => {
  const g = weightedGraph(["a", "b", "c"], "a", [
    L("a", "c", 0.5),
    L("a", "b"),
    L("a", "b", 0.2),
    L("b", "b"),
  ]);

  it("stores sorted CSR rows, summing duplicates and dropping self-loops", () => {
    expect([...g.offsets]).toEqual([0, 2, 2, 2]);
    expect([...g.targets]).toEqual([1, 2]);
    expect([...g.weights]).toEqual([1.2, 0.5]);
    expect(() => weightedGraph(["a"], "a", [L("a", "zz")])).toThrow(/unknown node/);
    expect(() => weightedGraph(["a"], "zz", [])).toThrow(/seed/);
  });

  it("adds a link on a copy, keeping rows sorted; the original is unchanged", () => {
    const h = withLink(g, 2, 0, 1);
    expect([...h.offsets]).toEqual([0, 2, 2, 3]);
    expect(linkWeight(h, 2, 0)).toEqual({ exists: true, weight: 1 });
    const h2 = withLink(g, 1, 2, 1);
    const h3 = withLink(h2, 1, 0, 1);
    expect([...h3.targets]).toEqual([1, 2, 0, 2]);
    expect(linkWeight(g, 2, 0)).toEqual({ exists: false, weight: 0 });
    expect([...g.targets]).toEqual([1, 2]);
  });

  it("raises an existing link to the body weight but never lowers it", () => {
    expect(linkWeight(withLink(g, 0, 2, 1), 0, 2).weight).toBe(1);
    expect(linkWeight(withLink(g, 0, 1, 1), 0, 1).weight).toBe(1.2);
    expect(g.weights[1]).toBe(0.5);
    expect(() => withLink(g, 1, 1, 1)).toThrow(/itself/);
  });
});

describe("weightedPagerank", () => {
  it("splits a node's rank in proportion to its link weights", () => {
    const g = weightedGraph(["a", "b", "c"], "a", [
      L("a", "b", 3),
      L("a", "c", 1),
      L("b", "a"),
      L("c", "a"),
    ]);
    const { scores, converged } = weightedPagerank(g, config);
    expect(converged).toBe(true);
    expect(sum(scores)).toBeCloseTo(1, 12);
    const d = config.pagerankDamping;
    // b and c receive only from a: (1-d)/3 + d·PR(a)·share.
    expect((scores[1] as number) - (1 - d) / 3).toBeCloseTo(
      3 * ((scores[2] as number) - (1 - d) / 3),
      9,
    );
  });

  it("matches the unweighted graph PageRank when weights are link counts", () => {
    const nodes = ["a", "b", "c", "d"];
    const links = [L("a", "b", 2), L("a", "c"), L("b", "c"), L("c", "a"), L("c", "d")];
    const w = weightedPagerank(weightedGraph(nodes, "a", links), config).scores;
    const index = new Map(nodes.map((n, i) => [n, i]));
    const out = nodes.map((n) =>
      links
        .filter((l) => l.source === n)
        .map((l) => [index.get(l.target) as number, l.weight] as const),
    );
    const collapsed: Collapsed = {
      nodes,
      index,
      out,
      outWeight: Float64Array.from(out, (r) => r.reduce((s, [, x]) => s + x, 0)),
    };
    const u = pagerank(
      collapsed,
      config.pagerankDamping,
      config.pagerankTolerance,
      config.pagerankMaxIterations,
    );
    for (let i = 0; i < nodes.length; i++) expect(w[i]).toBeCloseTo(u.scores[i] as number, 12);
  });

  it("spreads dangling rank uniformly, including nodes whose links all weigh 0", () => {
    const g = weightedGraph(["a", "b", "c"], "a", [L("a", "b"), L("b", "c", 0)]);
    const { scores } = weightedPagerank(g, config);
    expect(sum(scores)).toBeCloseTo(1, 12);
    expect(scores[2]).toBeCloseTo(scores[0] as number, 12); // b's zero-weight link carries nothing
  });

  it("reports non-convergence at the iteration cap", () => {
    const g = weightedGraph(["a", "b"], "a", [L("a", "b"), L("b", "a")]);
    const r = weightedPagerank(g, {
      ...config,
      pagerankMaxIterations: 1,
      pagerankTolerance: 1e-15,
    });
    expect(r).toMatchObject({ iterations: 1 });
  });
});

describe("depthFromSeed", () => {
  it("counts clicks from the home page over every link (weight 0 included); -1 unreachable", () => {
    const g = weightedGraph(["h", "a", "b", "z"], "h", [L("h", "a", 0), L("a", "b")]);
    expect([...depthFromSeed(g)]).toEqual([0, 1, 2, -1]);
  });
});

// ---------- simulate ----------
// h → a → b → c → d (a chain), h → x; "o" is linked from nowhere.
const nodes = ["h", "a", "b", "c", "d", "x", "o"];
const chain = weightedGraph(nodes, "h", [
  L("h", "a"),
  L("a", "b"),
  L("b", "c"),
  L("c", "d"),
  L("h", "x", 0.1),
  L("x", "h"),
  L("d", "h"),
]);
const base = baseline(chain, config);
const at = (n: string) => nodes.indexOf(n);
const scenario = (u: string, v: string, action: Scenario["action"] = "add-link"): Scenario => ({
  id: `${action}:${u}->${v}`,
  donor: at(u),
  target: at(v),
  action,
});

describe("simulate", () => {
  it("adding a link raises the target's PageRank and shortens its depth", () => {
    const r = simulate(chain, base, scenario("h", "d"), 1, config);
    expect(r).toMatchObject({ donor: "h", target: "d", weightBefore: 0, weightAfter: 1 });
    expect(r.deltaPrTarget).toBeGreaterThan(0);
    expect(r.prAfter - r.prBefore).toBe(r.deltaPrTarget);
    expect(r).toMatchObject({ depthBefore: 4, depthAfter: 1, deltaDepth: -3, converged: true });
    expect(r.deltaPrL1).toBeGreaterThanOrEqual(2 * r.deltaPrTarget - 1e-12); // mass moves, sum stays 1
  });

  it("a link to an unreachable page makes it reachable (Δdepth undefined)", () => {
    const r = simulate(chain, base, scenario("a", "o"), 1, config);
    expect(r).toMatchObject({ depthBefore: null, depthAfter: 2, deltaDepth: null });
    expect(r.deltaPrTarget).toBeGreaterThan(0);
  });

  it("make-visible raises the existing link's weight to the body weight", () => {
    const r = simulate(chain, base, scenario("h", "x", "make-visible"), 1, config);
    expect(r).toMatchObject({ weightBefore: 0.1, weightAfter: 1, deltaDepth: 0 });
    expect(r.deltaPrTarget).toBeGreaterThan(0);
    // Already at (or above) the body weight: nothing changes.
    const same = simulate(chain, base, scenario("h", "a", "make-visible"), 1, config);
    expect(same.weightAfter).toBe(1);
    expect(Math.abs(same.deltaPrTarget)).toBeLessThan(config.pagerankTolerance);
  });

  it("never modifies the baseline graph or vector", () => {
    const rank = Float64Array.from(base.rank);
    const targets = Int32Array.from(chain.targets);
    simulate(chain, base, scenario("b", "o"), 1, config);
    expect(base.rank).toEqual(rank);
    expect(chain.targets).toEqual(targets);
  });
});

// ---------- warm start vs cold start ----------
function randomSite(n: number, degree: number, seed: number): WeightedGraph {
  const r = mulberry32(seed);
  const ids = Array.from({ length: n }, (_, i) => `p${String(i).padStart(3, "0")}`);
  const links = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < degree; k++) {
      const j = Math.floor(r() * n);
      if (j !== i)
        links.push(L(ids[i] as string, ids[j] as string, [1, 0.3, 0.1, 0.5][k % 4] as number));
    }
  }
  return weightedGraph(ids, "p000", links);
}

describe("warm start", () => {
  const g = randomSite(200, 8, 3);
  const b = baseline(g, config);
  const r = mulberry32(9);
  const scenarios: Scenario[] = Array.from({ length: 40 }, (_, i) => {
    const u = Math.floor(r() * 200);
    const v = (u + 1 + Math.floor(r() * 199)) % 200;
    return { id: `s${i}`, donor: u, target: v, action: "add-link" };
  });

  it("gives the same PageRank as a cold start, to within the tolerance, on a sample", () => {
    const v = validateWarmStart(g, b, scenarios, 1, config, 10, config.randomSeed);
    expect(v.sample).toHaveLength(10);
    expect(v.maxL1Difference).toBeLessThanOrEqual(config.pagerankTolerance);
    expect(v.maxTargetDifference).toBeLessThanOrEqual(config.pagerankTolerance);
    expect(v.passed).toBe(true);
    expect(v.meanIterationsWarm).toBeLessThanOrEqual(v.meanIterationsCold);
  });

  it("agrees with a cold start on every reported number", () => {
    for (const s of scenarios.slice(0, 10)) {
      const warm = simulate(g, b, s, 1, config, true);
      const cold = simulate(g, b, s, 1, config, false);
      expect(Math.abs(warm.deltaPrTarget - cold.deltaPrTarget)).toBeLessThanOrEqual(
        config.pagerankTolerance,
      );
      expect(Math.abs(warm.deltaPrL1 - cold.deltaPrL1)).toBeLessThanOrEqual(
        config.pagerankTolerance,
      );
      expect(warm.deltaDepth).toBe(cold.deltaDepth);
    }
  });

  it("gives identical results when one workspace is reused for every scenario", () => {
    const ws = workspace(g);
    for (const s of scenarios) {
      expect(simulate(g, b, s, 1, config, true, ws)).toEqual(simulate(g, b, s, 1, config, true));
    }
    // make-visible on an existing link (no insertion) through the same workspace
    const existing = {
      id: "vis",
      donor: 0,
      target: g.targets[0] as number,
      action: "make-visible" as const,
    };
    expect(simulate(g, b, existing, 1, config, true, ws)).toEqual(
      simulate(g, b, existing, 1, config),
    );
  });

  it("draws the same sample for the same seed", () => {
    const a = validateWarmStart(g, b, scenarios, 1, config, 5, 42).sample;
    expect(validateWarmStart(g, b, scenarios, 1, config, 5, 42).sample).toEqual(a);
  });
});
