import { loadAudit } from "../audit/structural.js";
import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import type { SigmaVariant } from "../config.js";
import { listArtefacts } from "../db/queries.js";
import type { Queryable } from "../db/types.js";
import { loadReconciliation } from "../discovery/reconcile.js";
import { FIX_RANKING_ARTEFACT, type FixRanking } from "../fixes/scoring.js";
import { deriveGraphFromObservations, loadRunGraphInputs } from "../graph/derive.js";
import { depthShift, jaccard, spearman } from "./stats.js";

export const POLICY_ORDER: readonly PolicyId[] = ["P0", "P1", "P2", "P3", "P4", "P5"];

export interface PolicyComparison {
  readonly policy: PolicyId;
  readonly policyVersion: string;
  readonly nodes: number;
  readonly edges: number;
  readonly reachable: number;
  readonly largestScc: number;
  readonly orphans: number;
  readonly issues: number;
  readonly meanDepth: number | null;
  /** Against the baseline policy, pages matched in P3 form. */
  readonly pagerankSpearman: number | null;
  readonly meanDepthShift: number | null;
  readonly meanAbsDepthShift: number | null;
  /** Fixes ranked under this policy with σ (null: no ranking stored yet). */
  readonly fixesRanked: number | null;
  readonly topFixesJaccard: number | null;
}

export interface SensitivityResult {
  readonly runId: number;
  readonly baselinePolicy: PolicyId;
  readonly sigma: SigmaVariant;
  readonly k: number;
  readonly policies: PolicyComparison[];
}

/**
 * E1: derive a run under all six policies and compare each with `baseline`. Pages are compared
 * in P3 form, where node ids of every policy meet: a P3 page's PageRank is the sum of its merged
 * nodes', its depth the smallest. The top-k fixes are compared as (donor, target) pairs in P3 form,
 * using the latest ranking stored under each policy with σ.
 */
export async function compareRunPolicies(
  db: Queryable,
  runId: number,
  baseline: PolicyId,
  k: number,
  sigma?: SigmaVariant,
): Promise<SensitivityResult> {
  const { observations, context, config } = await loadRunGraphInputs(db, runId);
  const p3 = (n: string) => POLICIES.P3.canonicalise(n, context);
  const s = sigma ?? config.sigmaVariant;

  const perPolicy = [];
  for (const id of POLICY_ORDER) {
    const derived = deriveGraphFromObservations(observations, id, context, config);
    const [rec, aud, rankings] = await Promise.all([
      loadReconciliation(db, runId, id),
      loadAudit(db, runId, id),
      listArtefacts(db, runId, { kind: FIX_RANKING_ARTEFACT, policyVersion: POLICIES[id].version }),
    ]);
    const ranking = rankings
      .map((r) => r.payload as unknown as FixRanking)
      .filter((p) => p.sigmaVariant === s)
      .at(-1);
    const pagerank = new Map<string, number>();
    const depth = new Map<string, number>();
    const depths: number[] = [];
    derived.graph.forEachNode((n, attrs) => {
      const key = p3(n);
      pagerank.set(key, (pagerank.get(key) ?? 0) + (attrs.pagerank ?? 0));
      if (attrs.depth !== null && attrs.depth !== undefined) {
        depths.push(attrs.depth);
        depth.set(key, Math.min(depth.get(key) ?? Infinity, attrs.depth));
      }
    });
    perPolicy.push({
      id,
      summary: derived.summary,
      orphans: rec.orphans.length,
      issues: aud.summary.total,
      pagerank,
      depth,
      meanDepth: depths.length === 0 ? null : depths.reduce((a, d) => a + d, 0) / depths.length,
      topFixes:
        ranking === undefined
          ? null
          : new Set(ranking.fixes.slice(0, k).map((f) => `${p3(f.donor)} -> ${p3(f.target)}`)),
      fixCount: ranking?.fixes.length ?? null,
    });
  }
  const base = perPolicy.find((r) => r.id === baseline) as (typeof perPolicy)[number];
  return {
    runId,
    baselinePolicy: baseline,
    sigma: s,
    k,
    policies: perPolicy.map((r) => {
      const shift = depthShift(r.depth, base.depth);
      return {
        policy: r.id,
        policyVersion: POLICIES[r.id].version,
        nodes: r.summary.nodes,
        edges: r.summary.edges,
        reachable: r.summary.reachable,
        largestScc: r.summary.largestSccSize,
        orphans: r.orphans,
        issues: r.issues,
        meanDepth: r.meanDepth,
        pagerankSpearman: spearman(r.pagerank, base.pagerank),
        meanDepthShift: shift?.mean ?? null,
        meanAbsDepthShift: shift?.meanAbs ?? null,
        fixesRanked: r.fixCount,
        topFixesJaccard:
          r.topFixes === null || base.topFixes === null ? null : jaccard(r.topFixes, base.topFixes),
      };
    }),
  };
}
