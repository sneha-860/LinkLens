import { fixes } from "@linklens/core";
import { compareE3, evaluateSelection, rankPool, type E3Inputs } from "../e3-baselines.js";

/** What analysis/ml writes per site (the model never trained on that site). */
export interface SitePredictions {
  readonly site: string;
  readonly runId: number;
  readonly trainedOn: string[];
  readonly labels: string;
  readonly features: string[];
  readonly params: Record<string, number>;
  readonly dataset: string;
  readonly createdAt: string;
  readonly fixes: Record<string, fixes.LearnedFix>;
  readonly pool: Record<string, { readonly priority: number; readonly raw: number }>;
}

/** Pure: the `learned-priority` artefact payload of one run from its site's predictions. */
export function learnedPayload(p: SitePredictions, policyVersion: string): fixes.LearnedPriority {
  return {
    version: fixes.LEARNED_VERSION,
    runId: p.runId,
    policyVersion,
    model: {
      site: p.site,
      trainedOn: [...p.trainedOn],
      labels: p.labels,
      features: [...p.features],
      params: p.params,
      dataset: p.dataset,
      createdAt: p.createdAt,
    },
    fixes: p.fixes,
  };
}

export interface E3LearnedRow {
  readonly k: number;
  readonly method: "S" | "learned" | "random";
  readonly totalDeltaPr: number;
  readonly selected: number;
  readonly targetsCovered: number;
}

/**
 * Pure: E3's joint measure (the top-k links applied together, ΔPR summed over the weak and orphan
 * pages) for LinkLens's S, the learned priority and the random baseline, on the same pool.
 * A pool entry without a priority ranks last under "learned".
 */
export function e3Comparison(
  inputs: E3Inputs,
  priority: ReadonlyMap<string, number>,
  ks: readonly number[],
  draws: number,
  seed: number,
): E3LearnedRow[] {
  const base = compareE3(inputs, ks, draws, seed);
  const learned = rankPool(
    inputs.pool.map((e) => ({ ...e, score: priority.get(e.id) ?? -1 })),
    "linklens",
  );
  const out: E3LearnedRow[] = [];
  for (const b of base.byK) {
    for (const method of ["linklens", "random"] as const) {
      const m = b.methods.find((x) => x.method === method);
      if (m === undefined) continue;
      out.push({
        k: b.k,
        method: method === "linklens" ? "S" : "random",
        totalDeltaPr: m.totalDeltaPr,
        selected: m.selected,
        targetsCovered: m.targetsCovered,
      });
    }
    const pick = learned.slice(0, b.k);
    const r = evaluateSelection(inputs, pick);
    out.push({
      k: b.k,
      method: "learned",
      totalDeltaPr: r.totalDeltaPr,
      selected: pick.length,
      targetsCovered: new Set(pick.map((e) => e.target)).size,
    });
  }
  return out;
}
