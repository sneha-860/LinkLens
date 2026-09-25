import { MultiDirectedGraph } from "graphology";
import { describe, expect, it } from "vitest";
import type { EdgeAttributes, LinkGraph, NodeAttributes } from "./build.js";
import { betweenness, bfsDepth, collapse, pagerank, scc, type Collapsed } from "./metrics.js";
import { mulberry32 } from "./random.js";

const D = 0.85;

/** Multigraph from "a>b" edge specs (repeat a spec for parallel edges); nodes sorted like buildLinkGraph. */
function graphOf(nodes: string[], edges: string[]): LinkGraph {
  const g = new MultiDirectedGraph<NodeAttributes, EdgeAttributes>({ allowSelfLoops: false });
  for (const n of [...nodes].sort()) {
    g.addNode(n, { crawled: true, pages: 1, representativeFetchId: null, selfLoops: 0 });
  }
  edges.forEach((e, i) => {
    const [s, t] = e.split(">") as [string, string];
    g.addEdgeWithKey(`obs:${i}`, s, t, {
      observationId: i,
      domRegion: null,
      anchorText: null,
      templateSignature: null,
      rel: null,
    });
  });
  return g;
}

const byName = (g: Collapsed, values: ArrayLike<number>) =>
  Object.fromEntries(g.nodes.map((n, i) => [n, values[i] as number]));

/**
 * Reference PageRank: solve (I − d·Pᵀ) x = (1 − d)/N · 1 exactly by Gaussian elimination, where
 * P is the row-stochastic transition matrix with dangling rows replaced by the uniform row.
 */
function referencePageRank(g: Collapsed, d: number): number[] {
  const n = g.nodes.length;
  const P = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const w = g.outWeight[i] ?? 0;
    const row = P[i] as number[];
    if (w === 0) row.fill(1 / n);
    else for (const [j, weight] of g.out[i] ?? []) row[j] = weight / w;
  }
  // A = I − d·Pᵀ, b = (1 − d)/n
  const A = Array.from({ length: n }, (_, r) =>
    Array.from({ length: n + 1 }, (_, c) =>
      c === n ? (1 - d) / n : (r === c ? 1 : 0) - d * ((P[c] as number[])[r] as number),
    ),
  );
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (
        Math.abs((A[r] as number[])[col] as number) >
        Math.abs((A[pivot] as number[])[col] as number)
      )
        pivot = r;
    }
    [A[col], A[pivot]] = [A[pivot] as number[], A[col] as number[]];
    const pr = A[col] as number[];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = A[r] as number[];
      const f = (row[col] as number) / (pr[col] as number);
      for (let c = col; c <= n; c++) row[c] = (row[c] as number) - f * (pr[c] as number);
    }
  }
  return A.map((row, r) => (row[n] as number) / (row[r] as number));
}

/** Reference betweenness by brute force: Σ_{s≠v≠t} σ_st(v)/σ_st from all-pairs BFS counts. */
function referenceBetweenness(g: Collapsed): number[] {
  const n = g.nodes.length;
  const dist: number[][] = [];
  const sigma: number[][] = [];
  for (let s = 0; s < n; s++) {
    const d = new Array<number>(n).fill(-1);
    const c = new Array<number>(n).fill(0);
    d[s] = 0;
    c[s] = 1;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      const v = q[h] as number;
      for (const [w] of g.out[v] ?? []) {
        if (d[w] === -1) {
          d[w] = (d[v] as number) + 1;
          q.push(w);
        }
        if (d[w] === (d[v] as number) + 1) c[w] = (c[w] as number) + (c[v] as number);
      }
    }
    dist.push(d);
    sigma.push(c);
  }
  const bc = new Array<number>(n).fill(0);
  for (let s = 0; s < n; s++)
    for (let t = 0; t < n; t++) {
      if (s === t || (dist[s] as number[])[t] === -1) continue;
      for (let v = 0; v < n; v++) {
        if (v === s || v === t) continue;
        const dsv = (dist[s] as number[])[v] as number;
        const dvt = (dist[v] as number[])[t] as number;
        if (dsv === -1 || dvt === -1 || dsv + dvt !== (dist[s] as number[])[t]) continue;
        bc[v] =
          (bc[v] as number) +
          (((sigma[s] as number[])[v] as number) * ((sigma[v] as number[])[t] as number)) /
            ((sigma[s] as number[])[t] as number);
      }
    }
  return bc;
}

/** A seeded random multigraph (some nodes dangling, some parallel edges). */
function randomGraph(seed: number, n: number, m: number): LinkGraph {
  const rnd = mulberry32(seed);
  const nodes = Array.from({ length: n }, (_, i) => `n${String(i).padStart(3, "0")}`);
  const edges: string[] = [];
  for (let k = 0; k < m; k++) {
    const s = Math.floor(rnd() * n);
    const t = Math.floor(rnd() * n);
    if (s !== t && s % 5 !== 4) edges.push(`${nodes[s]}>${nodes[t]}`); // every 5th node dangling
  }
  return graphOf(nodes, edges);
}

describe("collapse", () => {
  it("turns parallel edges into weights, in sorted node order", () => {
    const g = collapse(graphOf(["b", "a", "c"], ["a>b", "a>b", "a>c", "c>a"]));
    expect(g.nodes).toEqual(["a", "b", "c"]);
    expect(g.out).toEqual([
      [
        [1, 2],
        [2, 1],
      ],
      [],
      [[0, 1]],
    ]);
    expect([...g.outWeight]).toEqual([3, 0, 1]);
  });
});

describe("pagerank: hand-computed graphs", () => {
  it("3-cycle: uniform 1/3", () => {
    const g = collapse(graphOf(["a", "b", "c"], ["a>b", "b>c", "c>a"]));
    const pr = pagerank(g, D, 1e-12, 1000);
    for (const v of pr.scores) expect(v).toBeCloseTo(1 / 3, 12);
    expect(pr.converged).toBe(true);
  });

  it("a→b with b dangling: x_a = 0.5/1.425, x_b = 1 − x_a", () => {
    // x_a = 0.075 + 0.425·x_b and x_a + x_b = 1  ⇒  1.425·x_a = 0.5
    const g = collapse(graphOf(["a", "b"], ["a>b"]));
    const pr = byName(g, pagerank(g, D, 1e-14, 1000).scores);
    expect(pr["a"]).toBeCloseTo(0.5 / 1.425, 12);
    expect(pr["b"]).toBeCloseTo(1 - 0.5 / 1.425, 12);
  });

  it("star a→b, a→c (b, c dangling): x_b = x_c = 1.425·x_a, x_a = 1/3.85", () => {
    const g = collapse(graphOf(["a", "b", "c"], ["a>b", "a>c"]));
    const pr = byName(g, pagerank(g, D, 1e-14, 1000).scores);
    expect(pr["a"]).toBeCloseTo(1 / 3.85, 12);
    expect(pr["b"]).toBeCloseTo(1.425 / 3.85, 12);
    expect(pr["c"]).toBeCloseTo(1.425 / 3.85, 12);
  });

  it("single isolated node: 1", () => {
    const g = collapse(graphOf(["a"], []));
    expect([...pagerank(g, D, 1e-12, 100).scores]).toEqual([1]);
  });

  it("parallel edges weight the transition: a→b ×2 beats a→c ×1", () => {
    const g = collapse(graphOf(["a", "b", "c"], ["a>b", "a>b", "a>c", "b>a", "c>a"]));
    const pr = byName(g, pagerank(g, D, 1e-14, 1000).scores);
    expect(pr["b"]).toBeGreaterThan(pr["c"] ?? 0);
    const ref = byName(g, referencePageRank(g, D));
    for (const n of g.nodes) expect(pr[n]).toBeCloseTo(ref[n] ?? NaN, 12);
  });
});

describe("pagerank: against the reference linear solve", () => {
  it.each([1, 2, 3, 4, 5, 6])("random multigraph with dangling nodes (seed %i)", (seed) => {
    const g = collapse(randomGraph(seed, 40, 120));
    const pr = pagerank(g, D, 1e-13, 10_000);
    const ref = referencePageRank(g, D);
    expect(pr.converged).toBe(true);
    pr.scores.forEach((v, i) => expect(v).toBeCloseTo(ref[i] ?? NaN, 10));
    expect(pr.scores.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
  });

  it.each([0.5, 0.85, 0.99])("damping %f", (d) => {
    const g = collapse(randomGraph(7, 25, 60));
    const pr = pagerank(g, d, 1e-13, 100_000);
    const ref = referencePageRank(g, d);
    pr.scores.forEach((v, i) => expect(v).toBeCloseTo(ref[i] ?? NaN, 9));
  });

  it("is bit-for-bit deterministic and reports non-convergence honestly", () => {
    const g = collapse(randomGraph(9, 50, 150));
    expect([...pagerank(g, D, 1e-12, 1000).scores]).toEqual([
      ...pagerank(g, D, 1e-12, 1000).scores,
    ]);
    const capped = pagerank(g, D, 1e-15, 3);
    expect(capped).toMatchObject({ iterations: 3, converged: false });
  });
});

describe("bfsDepth", () => {
  it("counts clicks from the seed; unreachable is -1", () => {
    const g = collapse(graphOf(["a", "b", "c", "d", "e"], ["a>b", "b>c", "a>c", "c>d", "e>a"]));
    expect(byName(g, bfsDepth(g, 0))).toEqual({ a: 0, b: 1, c: 1, d: 2, e: -1 });
  });
});

describe("scc", () => {
  it("finds components with deterministic ids and the largest one", () => {
    // {a,b,c} cycle → {d,e} cycle, f isolated, g → a
    const g = collapse(
      graphOf(
        ["a", "b", "c", "d", "e", "f", "g"],
        ["a>b", "b>c", "c>a", "c>d", "d>e", "e>d", "g>a"],
      ),
    );
    const r = scc(g);
    expect(byName(g, r.component)).toEqual({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 2, g: 3 });
    expect(r.sizes).toEqual([3, 2, 1, 1]);
    expect(r.largest).toBe(0);
  });

  it("breaks size ties by the smallest node", () => {
    const g = collapse(graphOf(["a", "b", "c", "d"], ["c>d", "d>c", "a>b", "b>a"]));
    const r = scc(g);
    expect(r.sizes).toEqual([2, 2]);
    expect(byName(g, r.component)["a"]).toBe(r.largest);
  });

  it("handles a long chain without recursion limits", () => {
    const nodes = Array.from({ length: 20_000 }, (_, i) => `n${String(i).padStart(5, "0")}`);
    const edges = nodes.slice(1).map((n, i) => `${nodes[i]}>${n}`);
    edges.push(`${nodes[nodes.length - 1]}>${nodes[0]}`);
    const r = scc(collapse(graphOf(nodes, edges)));
    expect(r.sizes).toEqual([20_000]);
  });
});

describe("betweenness", () => {
  const exact = { exactMaxNodes: 1000, samples: 10, seed: 42 };

  it("path a→b→c: only b lies between (1 pair)", () => {
    const g = collapse(graphOf(["a", "b", "c"], ["a>b", "b>c"]));
    expect(byName(g, betweenness(g, exact).scores)).toEqual({ a: 0, b: 1, c: 0 });
  });

  it("two equal shortest paths split the credit", () => {
    // a→b→d and a→c→d: b and c each get 1/2
    const g = collapse(graphOf(["a", "b", "c", "d"], ["a>b", "a>c", "b>d", "c>d"]));
    expect(byName(g, betweenness(g, exact).scores)).toEqual({ a: 0, b: 0.5, c: 0.5, d: 0 });
  });

  it("ignores edge multiplicity (shortest paths are unweighted)", () => {
    const g = collapse(graphOf(["a", "b", "c"], ["a>b", "a>b", "b>c"]));
    expect(byName(g, betweenness(g, exact).scores)["b"]).toBe(1);
  });

  it.each([11, 12, 13])("matches brute force on a random graph (seed %i)", (seed) => {
    const g = collapse(randomGraph(seed, 30, 90));
    const bc = betweenness(g, exact);
    expect(bc.sampled).toBe(false);
    const ref = referenceBetweenness(g);
    bc.scores.forEach((v, i) => expect(v).toBeCloseTo(ref[i] ?? NaN, 9));
  });

  it("samples sources above exactMaxNodes, deterministically per seed", () => {
    const g = collapse(randomGraph(21, 60, 240));
    const a = betweenness(g, { exactMaxNodes: 50, samples: 20, seed: 42 });
    const b = betweenness(g, { exactMaxNodes: 50, samples: 20, seed: 42 });
    const c = betweenness(g, { exactMaxNodes: 50, samples: 20, seed: 7 });
    expect(a).toMatchObject({ sampled: true, sources: 20 });
    expect([...a.scores]).toEqual([...b.scores]);
    expect([...a.scores]).not.toEqual([...c.scores]);
    // Unbiased estimate: total betweenness is in the right ballpark.
    const total = (x: ArrayLike<number>) => Array.from(x).reduce((s, v) => s + v, 0);
    const exactTotal = total(referenceBetweenness(g));
    expect(total(a.scores)).toBeGreaterThan(exactTotal * 0.5);
    expect(total(a.scores)).toBeLessThan(exactTotal * 1.5);
  });

  it("is exact when there are fewer nodes than samples", () => {
    const g = collapse(randomGraph(22, 40, 100));
    const bc = betweenness(g, { exactMaxNodes: 10, samples: 100, seed: 42 });
    expect(bc.sampled).toBe(false);
    const ref = referenceBetweenness(g);
    bc.scores.forEach((v, i) => expect(v).toBeCloseTo(ref[i] ?? NaN, 9));
  });
});
