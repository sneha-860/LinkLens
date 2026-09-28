import type { FixRecord } from "./scoring.js";

/**
 * The L13 ML prioritiser's output, served as the "learned" scoring mode. The model is trained
 * offline (analysis/ml, LightGBM lambdarank on E6 hide-and-recover labels, site-grouped: the
 * priorities of a site come from a model that never saw it) and imported per run as a
 * `learned-priority` artefact. S stays the default; "learned" only reorders the fixes.
 */
export const LEARNED_VERSION = "learned@1.0.0";
export const LEARNED_ARTEFACT = "learned-priority";

/** One feature's SHAP contribution to a fix's raw model score. */
export interface LearnedContribution {
  readonly feature: string;
  /** The feature's value for this fix (a number, or a category such as a page type). */
  readonly value: number | string | null;
  /** Its SHAP value: how much it moved the raw score (log-odds-like units of the ranker). */
  readonly contribution: number;
}

export interface LearnedFix {
  /** In [0, 1]: the raw score's mid-rank percentile among the site's fixes. */
  readonly priority: number;
  readonly raw: number;
  /** The largest |SHAP| contributions (l13ShapTop), largest first. */
  readonly shap: LearnedContribution[];
}

export interface LearnedPriority {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly model: {
    /** The site this artefact is for, and the sites the model was trained on (never it). */
    readonly site: string;
    readonly trainedOn: string[];
    readonly labels: string;
    readonly features: string[];
    readonly params: Readonly<Record<string, number>>;
    /** The analysis run that produced it (dataset hash, created at). */
    readonly dataset: string;
    readonly createdAt: string;
  };
  /** By fix id (`${type}:${donor}->${target}`). */
  readonly fixes: Record<string, LearnedFix>;
}

/** A fix as the "learned" mode serves it: ranked by priority, S kept for comparison. */
export interface LearnedFixRecord extends Omit<FixRecord, "scoring"> {
  readonly scoring: "learned";
  readonly learned: LearnedFix | null;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pure: the fixes reordered by learned priority (fixes without one go last, in their S order),
 * with `score` = priority (0 without one), `scoring` "learned", and rank and target rank anew.
 */
export function applyLearned(
  fixes: readonly FixRecord[],
  learned: Pick<LearnedPriority, "fixes">,
): LearnedFixRecord[] {
  const sOrder = new Map(fixes.map((f, i) => [f.id, i]));
  const ranked = fixes
    .map((f) => ({ f, l: learned.fixes[f.id] ?? null }))
    .sort(
      (a, b) =>
        (a.l === null ? 1 : 0) - (b.l === null ? 1 : 0) ||
        (b.l?.priority ?? 0) - (a.l?.priority ?? 0) ||
        (b.l?.raw ?? 0) - (a.l?.raw ?? 0) ||
        (sOrder.get(a.f.id) as number) - (sOrder.get(b.f.id) as number) ||
        cmp(a.f.id, b.f.id),
    );
  const perTarget = new Map<string, number>();
  return ranked.map(({ f, l }, i) => {
    const t = (perTarget.get(f.target) ?? 0) + 1;
    perTarget.set(f.target, t);
    return {
      ...f,
      score: l?.priority ?? 0,
      scoring: "learned",
      learned: l,
      rank: i + 1,
      targetRank: t,
    };
  });
}
