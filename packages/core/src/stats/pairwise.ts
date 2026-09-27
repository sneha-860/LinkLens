import type { PolicyId } from "../canonicalise/index.js";
import type { PolicySnapshot, PolicySnapshots } from "./sensitivity.js";
import { jaccard, spearman } from "./stats.js";

/**
 * Two policies' views of one run, compared in P3 form (E1). `a` is the earlier policy in P0–P5
 * order and every signed difference is b − a, so a positive depth shift means pages are deeper
 * under b.
 */
export interface PolicyPairComparison {
  readonly a: PolicyId;
  readonly b: PolicyId;
  /** Node counts in each policy's own graph, b − a, and b / a (null when a has none). */
  readonly nodesA: number;
  readonly nodesB: number;
  readonly nodeDelta: number;
  readonly nodeRatio: number | null;
  /** P3 pages present under both, and their Jaccard over the union. */
  readonly sharedNodes: number;
  readonly nodeJaccard: number;
  /** Reconciled orphans in P3 form (Jaccard 1 when neither has any). */
  readonly orphansA: number;
  readonly orphansB: number;
  readonly orphanJaccard: number;
  /** Spearman of PageRank over the shared P3 pages (null: < 2 shared or no variation). */
  readonly pagerankSpearman: number | null;
  /** Depth over P3 pages reachable under both: mean (b − a), mean |b − a| and max |b − a|. */
  readonly depthPages: number;
  readonly meanDepthShift: number | null;
  readonly meanAbsDepthShift: number | null;
  readonly maxAbsDepthShift: number | null;
  /** Jaccard of the top-k fixes as (donor, target) pairs; null unless both are ranked. */
  readonly topFixesJaccard: number | null;
}

export interface PolicyPairsResult {
  readonly runId: number;
  readonly sigma: string;
  readonly k: number;
  /** Every unordered pair once, in P0–P5 order: (P0,P1), (P0,P2), … (P4,P5). */
  readonly pairs: PolicyPairComparison[];
}

/** Pure: compare two snapshots of the same run. */
export function comparePolicyPair(a: PolicySnapshot, b: PolicySnapshot): PolicyPairComparison {
  let shared = 0;
  for (const key of a.pagerank.keys()) if (b.pagerank.has(key)) shared += 1;
  const union = a.pagerank.size + b.pagerank.size - shared;

  let depthPages = 0;
  let sum = 0;
  let abs = 0;
  let max = 0;
  for (const [key, da] of a.depth) {
    const db = b.depth.get(key);
    if (db === undefined) continue;
    const d = db - da;
    depthPages += 1;
    sum += d;
    abs += Math.abs(d);
    max = Math.max(max, Math.abs(d));
  }

  return {
    a: a.policy,
    b: b.policy,
    nodesA: a.nodes,
    nodesB: b.nodes,
    nodeDelta: b.nodes - a.nodes,
    nodeRatio: a.nodes === 0 ? null : b.nodes / a.nodes,
    sharedNodes: shared,
    nodeJaccard: union === 0 ? 1 : shared / union,
    orphansA: a.orphans.size,
    orphansB: b.orphans.size,
    orphanJaccard: jaccard(a.orphans, b.orphans),
    pagerankSpearman: spearman(a.pagerank, b.pagerank),
    depthPages,
    meanDepthShift: depthPages === 0 ? null : sum / depthPages,
    meanAbsDepthShift: depthPages === 0 ? null : abs / depthPages,
    maxAbsDepthShift: depthPages === 0 ? null : max,
    topFixesJaccard:
      a.topFixes === null || b.topFixes === null ? null : jaccard(a.topFixes, b.topFixes),
  };
}

/** Pure: every unordered pair of the snapshots, in their order (15 pairs for P0–P5). */
export function comparePolicyPairs(s: PolicySnapshots): PolicyPairsResult {
  const pairs: PolicyPairComparison[] = [];
  s.snapshots.forEach((a, i) => {
    for (const b of s.snapshots.slice(i + 1)) pairs.push(comparePolicyPair(a, b));
  });
  return { runId: s.runId, sigma: s.sigma, k: s.k, pairs };
}
