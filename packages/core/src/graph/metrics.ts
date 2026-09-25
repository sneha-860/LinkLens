import type { LinkGraph } from "./build.js";
import { mulberry32, sampleWithoutReplacement } from "./random.js";

/**
 * The multigraph collapsed to a weighted simple digraph over integer node indices (graph order,
 * which buildLinkGraph makes sorted). weight(u→v) = number of parallel link observations.
 */
export interface Collapsed {
  readonly nodes: readonly string[];
  readonly index: ReadonlyMap<string, number>;
  /** out[i] = [[j, weight], …] sorted by j. */
  readonly out: readonly (readonly (readonly [number, number])[])[];
  /** Total out-weight per node. */
  readonly outWeight: Float64Array;
}

export function collapse(graph: LinkGraph): Collapsed {
  const nodes = graph.nodes();
  const index = new Map(nodes.map((n, i) => [n, i]));
  const out = nodes.map((n) => {
    const w = new Map<number, number>();
    graph.forEachOutEdge(n, (_e, _a, _s, t) => {
      const j = index.get(t) as number;
      w.set(j, (w.get(j) ?? 0) + 1);
    });
    return [...w].sort((a, b) => a[0] - b[0]);
  });
  const outWeight = Float64Array.from(out, (edges) => edges.reduce((s, [, w]) => s + w, 0));
  return { nodes, index, out, outWeight };
}

export interface PageRankResult {
  readonly scores: Float64Array;
  readonly iterations: number;
  readonly converged: boolean;
}

/**
 * Weighted PageRank by power iteration:
 *   PR(v) = (1 − d)/N + d·Σ_u PR(u)·w(u→v)/W(u) + d·Σ_{dangling u} PR(u)/N
 * Dangling nodes (no out-links) spread their rank uniformly over all nodes, so scores always sum
 * to 1. Starts uniform; stops when the L1 change is < tolerance or after maxIterations.
 * Nodes and edges are visited in a fixed order, so results are bit-for-bit reproducible.
 */
export function pagerank(
  g: Collapsed,
  damping: number,
  tolerance: number,
  maxIterations: number,
): PageRankResult {
  const n = g.nodes.length;
  if (n === 0) return { scores: new Float64Array(0), iterations: 0, converged: true };
  let x = new Float64Array(n).fill(1 / n);
  for (let it = 1; it <= maxIterations; it++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if ((g.outWeight[i] ?? 0) === 0) dangling += x[i] ?? 0;
    const y = new Float64Array(n).fill((1 - damping) / n + (damping * dangling) / n);
    for (let i = 0; i < n; i++) {
      const w = g.outWeight[i] ?? 0;
      if (w === 0) continue;
      const share = (damping * (x[i] ?? 0)) / w;
      for (const [j, weight] of g.out[i] ?? []) y[j] = (y[j] ?? 0) + share * weight;
    }
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs((y[i] ?? 0) - (x[i] ?? 0));
    x = y;
    if (diff < tolerance) return { scores: x, iterations: it, converged: true };
  }
  return { scores: x, iterations: maxIterations, converged: false };
}

/** BFS click depth from `source` over out-links; -1 = unreachable. */
export function bfsDepth(g: Collapsed, source: number): Int32Array {
  const depth = new Int32Array(g.nodes.length).fill(-1);
  depth[source] = 0;
  const queue = [source];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head] as number;
    for (const [v] of g.out[u] ?? []) {
      if (depth[v] === -1) {
        depth[v] = (depth[u] ?? 0) + 1;
        queue.push(v);
      }
    }
  }
  return depth;
}

export interface SccResult {
  /** Component id per node. Ids are ordered by each component's smallest node index. */
  readonly component: Int32Array;
  readonly sizes: readonly number[];
  /** Id of the largest component (ties: the one with the smallest node). */
  readonly largest: number;
}

/** Strongly connected components (iterative Tarjan), with deterministic component ids. */
export function scc(g: Collapsed): SccResult {
  const n = g.nodes.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const raw = new Int32Array(n).fill(-1);
  let next = 0;
  let comps = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: [node: number, edge: number][] = [[root, 0]];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length > 0) {
      const frame = work[work.length - 1] as [number, number];
      const [v, ei] = frame;
      const edges = g.out[v] ?? [];
      if (ei < edges.length) {
        frame[1] = ei + 1;
        const w = (edges[ei] as readonly [number, number])[0];
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w] === 1) {
          low[v] = Math.min(low[v] ?? 0, index[w] ?? 0);
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = (work[work.length - 1] as [number, number])[0];
        low[parent] = Math.min(low[parent] ?? 0, low[v] ?? 0);
      }
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = stack.pop() as number;
          onStack[w] = 0;
          raw[w] = comps;
        } while (w !== v);
        comps++;
      }
    }
  }

  // Renumber components by their smallest member index.
  const firstSeen = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = raw[i] as number;
    if (!firstSeen.has(c)) firstSeen.set(c, firstSeen.size);
  }
  const component = Int32Array.from(raw, (c) => firstSeen.get(c) as number);
  const sizes = new Array<number>(firstSeen.size).fill(0);
  for (const c of component) sizes[c] = (sizes[c] ?? 0) + 1;
  let largest = 0;
  for (let c = 1; c < sizes.length; c++) if ((sizes[c] ?? 0) > (sizes[largest] ?? 0)) largest = c;
  return { component, sizes, largest };
}

export interface BetweennessResult {
  /** Raw directed betweenness (ordered pairs), scaled by N/k when sampled. */
  readonly scores: Float64Array;
  readonly sampled: boolean;
  /** Source nodes used (all nodes when exact). */
  readonly sources: number;
}

/**
 * Brandes betweenness on the unweighted directed simple graph. Exact when N ≤ exactMaxNodes;
 * otherwise estimated from `samples` source nodes drawn with a seeded PRNG and scaled by N/k
 * (an unbiased estimator of the exact value).
 */
export function betweenness(
  g: Collapsed,
  options: { exactMaxNodes: number; samples: number; seed: number },
): BetweennessResult {
  const n = g.nodes.length;
  const all = [...Array(n).keys()];
  const sampled = n > options.exactMaxNodes && options.samples < n;
  const sources = sampled
    ? sampleWithoutReplacement(all, options.samples, mulberry32(options.seed))
    : all;
  const cb = new Float64Array(n);

  const sigma = new Float64Array(n);
  const dist = new Int32Array(n);
  const delta = new Float64Array(n);
  for (const s of sources) {
    sigma.fill(0);
    dist.fill(-1);
    delta.fill(0);
    const preds: number[][] = Array.from({ length: n }, () => []);
    const order: number[] = [];
    sigma[s] = 1;
    dist[s] = 0;
    const queue = [s];
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head] as number;
      order.push(v);
      for (const [w] of g.out[v] ?? []) {
        if (dist[w] === -1) {
          dist[w] = (dist[v] ?? 0) + 1;
          queue.push(w);
        }
        if (dist[w] === (dist[v] ?? 0) + 1) {
          sigma[w] = (sigma[w] ?? 0) + (sigma[v] ?? 0);
          (preds[w] as number[]).push(v);
        }
      }
    }
    for (let k = order.length - 1; k >= 0; k--) {
      const w = order[k] as number;
      for (const v of preds[w] as number[]) {
        delta[v] = (delta[v] ?? 0) + ((sigma[v] ?? 0) / (sigma[w] ?? 1)) * (1 + (delta[w] ?? 0));
      }
      if (w !== s) cb[w] = (cb[w] ?? 0) + (delta[w] ?? 0);
    }
  }
  if (sampled) {
    const scale = n / sources.length;
    for (let i = 0; i < n; i++) cb[i] = (cb[i] ?? 0) * scale;
  }
  return { scores: cb, sampled, sources: sources.length };
}
