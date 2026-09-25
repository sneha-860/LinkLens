import type { LinkLensConfig } from "../config.js";
import { mulberry32, sampleWithoutReplacement } from "../graph/random.js";
import type { CandidateAction } from "./candidates.js";

/** Bump whenever the output can change (graph weights, added weight, PageRank, depth). */
export const COUNTERFACTUAL_VERSION = "counterfactual@1.0.0";
export const COUNTERFACTUAL_ARTEFACT = "counterfactual";

/**
 * A weighted directed graph in CSR form: node i's links are targets/weights[offsets[i] ..
 * offsets[i+1]), sorted by target. Plain typed arrays, so it can be sent to worker threads.
 * A link with weight 0 still exists (it counts for depth, not for PageRank).
 */
export interface WeightedGraph {
  readonly nodes: readonly string[];
  /** Index of the home page (BFS source). */
  readonly seed: number;
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly weights: Float64Array;
}

export type PageRankParams = Pick<
  LinkLensConfig,
  "pagerankDamping" | "pagerankTolerance" | "pagerankMaxIterations"
>;

/** Build the graph from weighted links (duplicates u→v are summed; self-loops dropped). */
export function weightedGraph(
  nodes: readonly string[],
  seedNode: string,
  links: readonly { readonly source: string; readonly target: string; readonly weight: number }[],
): WeightedGraph {
  const index = new Map(nodes.map((n, i) => [n, i]));
  const seed = index.get(seedNode);
  if (seed === undefined) throw new Error(`seed ${seedNode} is not a node`);
  const rows: Map<number, number>[] = nodes.map(() => new Map());
  for (const l of links) {
    const s = index.get(l.source);
    const t = index.get(l.target);
    if (s === undefined || t === undefined)
      throw new Error(`link ${l.source} → ${l.target}: unknown node`);
    if (s === t) continue;
    const row = rows[s] as Map<number, number>;
    row.set(t, (row.get(t) ?? 0) + l.weight);
  }
  return fromRows(
    nodes,
    seed,
    rows.map((r) => [...r].sort((a, b) => a[0] - b[0])),
  );
}

function fromRows(
  nodes: readonly string[],
  seed: number,
  rows: readonly (readonly [number, number])[][],
): WeightedGraph {
  const offsets = new Int32Array(nodes.length + 1);
  rows.forEach((r, i) => (offsets[i + 1] = (offsets[i] as number) + r.length));
  const m = offsets[nodes.length] as number;
  const targets = new Int32Array(m);
  const weights = new Float64Array(m);
  let k = 0;
  for (const r of rows) {
    for (const [t, w] of r) {
      targets[k] = t;
      weights[k++] = w;
    }
  }
  return { nodes, seed, offsets, targets, weights };
}

/** Weight of the link u→v (0 if absent) and whether it exists. */
export function linkWeight(
  g: WeightedGraph,
  u: number,
  v: number,
): { exists: boolean; weight: number } {
  for (let k = g.offsets[u] as number; k < (g.offsets[u + 1] as number); k++) {
    if (g.targets[k] === v) return { exists: true, weight: g.weights[k] as number };
  }
  return { exists: false, weight: 0 };
}

/**
 * Reusable buffers for simulating many candidates on one graph without allocating per candidate
 * (in parallel workers, per-candidate typed-array allocation contends on the process allocator).
 * Arrays returned while using a workspace are views into it, valid until its next use.
 */
export interface Workspace {
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly weights: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly out: Float64Array;
  readonly depth: Int32Array;
  readonly queue: Int32Array;
}

/** A workspace for `g` and any copy of it with one more link. */
export function workspace(g: WeightedGraph): Workspace {
  const n = g.nodes.length;
  const m = g.targets.length + 1;
  return {
    offsets: new Int32Array(n + 1),
    targets: new Int32Array(m),
    weights: new Float64Array(m),
    x: new Float64Array(n),
    y: new Float64Array(n),
    out: new Float64Array(n),
    depth: new Int32Array(n),
    queue: new Int32Array(n),
  };
}

/**
 * A copy of `g` with the link u→v set to at least `weight`: added if absent, raised if lighter
 * (never lowered). `g` itself is not changed. With a workspace the copy is written into it.
 */
export function withLink(
  g: WeightedGraph,
  u: number,
  v: number,
  weight: number,
  ws?: Workspace,
): WeightedGraph {
  if (u === v) throw new Error("a page cannot link to itself");
  const lo = g.offsets[u] as number;
  const hi = g.offsets[u + 1] as number;
  let at = lo;
  while (at < hi && (g.targets[at] as number) < v) at++;
  const exists = at < hi && g.targets[at] === v;
  const m = g.targets.length + (exists ? 0 : 1);
  const n1 = g.offsets.length;
  const offsets = ws === undefined ? new Int32Array(n1) : ws.offsets.subarray(0, n1);
  const targets = ws === undefined ? new Int32Array(m) : ws.targets.subarray(0, m);
  const weights = ws === undefined ? new Float64Array(m) : ws.weights.subarray(0, m);
  offsets.set(g.offsets);
  if (exists) {
    targets.set(g.targets);
    weights.set(g.weights);
    weights[at] = Math.max(weights[at] as number, weight);
  } else {
    targets.set(g.targets.subarray(0, at));
    weights.set(g.weights.subarray(0, at));
    targets[at] = v;
    weights[at] = weight;
    targets.set(g.targets.subarray(at), at + 1);
    weights.set(g.weights.subarray(at), at + 1);
    for (let i = u + 1; i < n1; i++) offsets[i] = (offsets[i] as number) + 1;
  }
  return { ...g, offsets, targets, weights };
}

export interface PageRankRun {
  readonly scores: Float64Array;
  readonly iterations: number;
  readonly converged: boolean;
}

/**
 * Weighted PageRank by power iteration: a node's rank flows along its links in proportion to
 * their weights; a node with no weighted out-links spreads its rank uniformly (dangling), as does
 * teleportation. Starts from `start` (a warm start) or the uniform vector, and stops when the L1
 * change of one iteration falls below the tolerance.
 */
export function weightedPagerank(
  g: WeightedGraph,
  params: PageRankParams,
  start?: Float64Array,
  ws?: Workspace,
): PageRankRun {
  const n = g.nodes.length;
  if (n === 0) return { scores: new Float64Array(0), iterations: 0, converged: true };
  const d = params.pagerankDamping;
  const out = ws === undefined ? new Float64Array(n) : ws.out.fill(0);
  for (let i = 0; i < n; i++) {
    for (let k = g.offsets[i] as number; k < (g.offsets[i + 1] as number); k++) {
      out[i] = (out[i] as number) + (g.weights[k] as number);
    }
  }
  let x = ws === undefined ? new Float64Array(n) : ws.x;
  let y = ws === undefined ? new Float64Array(n) : ws.y;
  if (start === undefined) x.fill(1 / n);
  else x.set(start);
  for (let it = 1; it <= params.pagerankMaxIterations; it++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if (out[i] === 0) dangling += x[i] as number;
    y.fill((1 - d) / n + (d * dangling) / n);
    for (let i = 0; i < n; i++) {
      const w = out[i] as number;
      if (w === 0) continue;
      const share = (d * (x[i] as number)) / w;
      for (let k = g.offsets[i] as number; k < (g.offsets[i + 1] as number); k++) {
        const j = g.targets[k] as number;
        y[j] = (y[j] as number) + share * (g.weights[k] as number);
      }
    }
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs((y[i] as number) - (x[i] as number));
    [x, y] = [y, x];
    if (diff < params.pagerankTolerance) return { scores: x, iterations: it, converged: true };
  }
  return { scores: x, iterations: params.pagerankMaxIterations, converged: false };
}

/** Click depth from the home page over every existing link (any weight); -1 = unreachable. */
export function depthFromSeed(g: WeightedGraph, ws?: Workspace): Int32Array {
  const n = g.nodes.length;
  const depth = ws === undefined ? new Int32Array(n) : ws.depth;
  const queue = ws === undefined ? new Int32Array(n) : ws.queue;
  depth.fill(-1);
  depth[g.seed] = 0;
  queue[0] = g.seed;
  let tail = 1;
  for (let head = 0; head < tail; head++) {
    const u = queue[head] as number;
    for (let k = g.offsets[u] as number; k < (g.offsets[u + 1] as number); k++) {
      const v = g.targets[k] as number;
      if (depth[v] === -1) {
        depth[v] = (depth[u] as number) + 1;
        queue[tail++] = v;
      }
    }
  }
  return depth;
}

export interface Baseline {
  readonly rank: Float64Array;
  readonly depth: Int32Array;
  readonly iterations: number;
  readonly converged: boolean;
}

/** The unmodified graph's PageRank (cold start) and depths. */
export function baseline(g: WeightedGraph, params: PageRankParams): Baseline {
  const pr = weightedPagerank(g, params);
  return {
    rank: pr.scores,
    depth: depthFromSeed(g),
    iterations: pr.iterations,
    converged: pr.converged,
  };
}

/** One candidate to simulate, by node index. */
export interface Scenario {
  readonly id: string;
  readonly donor: number;
  readonly target: number;
  readonly action: CandidateAction;
}

export interface CounterfactualResult {
  readonly candidateId: string;
  readonly donor: string;
  readonly target: string;
  readonly action: CandidateAction;
  /** W(u,v) before (0 if there was no link) and after. */
  readonly weightBefore: number;
  readonly weightAfter: number;
  readonly prBefore: number;
  readonly prAfter: number;
  /** PR'(v) − PR(v). */
  readonly deltaPrTarget: number;
  /** Σ_i |PR'(i) − PR(i)| over the whole site. */
  readonly deltaPrL1: number;
  /** Clicks from the home page before and after (null = unreachable). */
  readonly depthBefore: number | null;
  readonly depthAfter: number | null;
  /** depthAfter − depthBefore (null when either is unreachable). */
  readonly deltaDepth: number | null;
  readonly iterations: number;
  readonly converged: boolean;
}

/**
 * Pure: copy the graph with u→v at the body weight (added, or the existing link raised to it),
 * recompute PageRank warm-started from the baseline, and compare with the baseline. Pass a
 * workspace (one per thread) when simulating many candidates on the same graph.
 */
export function simulate(
  g: WeightedGraph,
  base: Baseline,
  s: Scenario,
  bodyWeight: number,
  params: PageRankParams,
  warmStart = true,
  ws?: Workspace,
): CounterfactualResult {
  const before = linkWeight(g, s.donor, s.target);
  const h = withLink(g, s.donor, s.target, bodyWeight, ws);
  const pr = weightedPagerank(h, params, warmStart ? base.rank : undefined, ws);
  let l1 = 0;
  for (let i = 0; i < pr.scores.length; i++) {
    l1 += Math.abs((pr.scores[i] as number) - (base.rank[i] as number));
  }
  const depth = depthFromSeed(h, ws);
  const d0 = base.depth[s.target] as number;
  const d1 = depth[s.target] as number;
  const prBefore = base.rank[s.target] as number;
  const prAfter = pr.scores[s.target] as number;
  return {
    candidateId: s.id,
    donor: g.nodes[s.donor] as string,
    target: g.nodes[s.target] as string,
    action: s.action,
    weightBefore: before.weight,
    weightAfter: Math.max(before.weight, bodyWeight),
    prBefore,
    prAfter,
    deltaPrTarget: prAfter - prBefore,
    deltaPrL1: l1,
    depthBefore: d0 < 0 ? null : d0,
    depthAfter: d1 < 0 ? null : d1,
    deltaDepth: d0 < 0 || d1 < 0 ? null : d1 - d0,
    iterations: pr.iterations,
    converged: pr.converged,
  };
}

export interface WarmStartValidation {
  /** Candidates re-run from a cold start (drawn with randomSeed). */
  readonly sample: string[];
  /** Largest Σ_i |PR_warm(i) − PR_cold(i)| over the sample, and the tolerance it must stay under. */
  readonly maxL1Difference: number;
  readonly maxTargetDifference: number;
  readonly tolerance: number;
  readonly passed: boolean;
  /** Mean power iterations per candidate from each start. */
  readonly meanIterationsWarm: number;
  readonly meanIterationsCold: number;
}

/**
 * Re-run a seeded sample of scenarios from a cold (uniform) start and compare with the warm
 * start: both stop at the same tolerance, so their vectors should agree to within it.
 */
export function validateWarmStart(
  g: WeightedGraph,
  base: Baseline,
  scenarios: readonly Scenario[],
  bodyWeight: number,
  params: PageRankParams,
  sampleSize: number,
  seed: number,
): WarmStartValidation {
  const sample = sampleWithoutReplacement(scenarios, sampleSize, mulberry32(seed));
  let maxL1 = 0;
  let maxTarget = 0;
  let warmIt = 0;
  let coldIt = 0;
  for (const s of sample) {
    const h = withLink(g, s.donor, s.target, bodyWeight);
    const warm = weightedPagerank(h, params, base.rank);
    const cold = weightedPagerank(h, params);
    let l1 = 0;
    for (let i = 0; i < warm.scores.length; i++) {
      l1 += Math.abs((warm.scores[i] as number) - (cold.scores[i] as number));
    }
    maxL1 = Math.max(maxL1, l1);
    maxTarget = Math.max(
      maxTarget,
      Math.abs((warm.scores[s.target] as number) - (cold.scores[s.target] as number)),
    );
    warmIt += warm.iterations;
    coldIt += cold.iterations;
  }
  return {
    sample: sample.map((s) => s.id),
    maxL1Difference: maxL1,
    maxTargetDifference: maxTarget,
    tolerance: params.pagerankTolerance,
    passed: maxL1 <= params.pagerankTolerance,
    meanIterationsWarm: sample.length === 0 ? 0 : warmIt / sample.length,
    meanIterationsCold: sample.length === 0 ? 0 : coldIt / sample.length,
  };
}
