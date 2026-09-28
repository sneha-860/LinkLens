import {
  SIGMA_VARIANTS,
  canonicalise,
  importance as importanceCore,
  stats,
  type FixScoring,
  type LinkLensConfig,
  type SigmaVariant,
} from "@linklens/core";
import type { Embedder } from "@linklens/embeddings";
import {
  buildE3Inputs,
  compareE3,
  evaluateSelection,
  rankPool,
  type E3Data,
  type PoolEntry,
} from "./e3-baselines.js";
import { maskingRecovery, type E6Method, type E6Result, type MethodMetrics } from "./e6-masking.js";
import { prepareRun, topFixKeys, type RunInputs } from "./in-memory.js";

type PolicyId = canonicalise.PolicyId;

/**
 * E7, the σ / ε / α ablation. For each σ variant, and for each σ along an ε sweep (at the default
 * α) and along an α sweep (at the default ε), the site's fixes are ranked again:
 * - top-k overlap: the Jaccard of the top-k fixes (k = fixTopK) with the default setting's, and
 *   between the σ variants at the default ε and α;
 * - E3 gain: LinkLens's top-k applied together (total ΔPR on the weak and orphan pages) and the
 *   random baseline on the same pool, for each k of e3TopKs;
 * - E6 recovery: the σ variant's link-masking recovery (cosineOnly → cosine, refOnly → REF,
 *   blended, refGateCosine gated at the setting's ε). α does not enter E6.
 *
 * The scoring sweep (L12): each σ at the default ε and α also under S_imp = S × importance(v).
 * E3 then ranks its pool by S_imp (an orphan target has its detached importance: the type prior
 * of its URL only). E6 is the same as under S by construction: it ranks the donors of one target,
 * and importance(target) is the same for all of them.
 */
export type Sweep = "sigma" | "epsilon" | "alpha" | "scoring";

export interface E7Setting {
  readonly sigma: SigmaVariant;
  readonly epsilon: number;
  readonly alpha: number;
  /** S (the ranking's default) or S_imp (L12). */
  readonly scoring: FixScoring;
  /** The run's own σ, ε, α and scoring. */
  readonly isDefault: boolean;
  /**
   * The sweeps this setting belongs to (σ: default ε and α under S; ε: default α; α: default ε;
   * scoring: default ε and α, under S and under S_imp).
   */
  readonly sweeps: Sweep[];
}

/** Pure: every setting of the three sweeps once, in a fixed order. */
export function e7Settings(
  config: Pick<
    LinkLensConfig,
    "sigmaVariant" | "epsilon" | "alpha" | "e7Epsilons" | "e7Alphas" | "fixScoring"
  >,
): E7Setting[] {
  const epsilons = [...new Set([...config.e7Epsilons, config.epsilon])].sort((a, b) => a - b);
  const alphas = [...new Set([...config.e7Alphas, config.alpha])].sort((a, b) => a - b);
  const out: E7Setting[] = [];
  const seen = new Set<string>();
  const add = (sigma: SigmaVariant, epsilon: number, alpha: number, scoring: FixScoring) => {
    const key = `${sigma}|${epsilon}|${alpha}|${scoring}`;
    if (seen.has(key)) return;
    seen.add(key);
    const atDefaults = epsilon === config.epsilon && alpha === config.alpha;
    const sweeps: Sweep[] = [];
    if (scoring === "S") {
      if (atDefaults) sweeps.push("sigma");
      if (alpha === config.alpha) sweeps.push("epsilon");
      if (epsilon === config.epsilon) sweeps.push("alpha");
    }
    if (atDefaults) sweeps.push("scoring");
    out.push({
      sigma,
      epsilon,
      alpha,
      scoring,
      isDefault: sigma === config.sigmaVariant && atDefaults && scoring === config.fixScoring,
      sweeps,
    });
  };
  for (const sigma of SIGMA_VARIANTS) {
    for (const epsilon of epsilons) add(sigma, epsilon, config.alpha, "S");
    for (const alpha of alphas) add(sigma, config.epsilon, alpha, "S");
    add(sigma, config.epsilon, config.alpha, "S_imp");
  }
  // σ in SIGMA_VARIANTS order, then ε, then α, then S before S_imp.
  const order = new Map(SIGMA_VARIANTS.map((s, i) => [s, i]));
  return out.sort(
    (a, b) =>
      (order.get(a.sigma) as number) - (order.get(b.sigma) as number) ||
      a.epsilon - b.epsilon ||
      a.alpha - b.alpha ||
      (a.scoring === b.scoring ? 0 : a.scoring === "S" ? -1 : 1),
  );
}

export interface E7Row extends E7Setting {
  /** Fixes ranked (every target), and the top-k Jaccard with the default setting's top-k. */
  readonly fixes: number;
  readonly topKJaccardDefault: number;
  /** E3 total ΔPR per k: LinkLens's top-k, and the random baseline on the same pool. */
  readonly e3: {
    readonly pool: number;
    readonly linklens: Record<number, number>;
    readonly random: Record<number, number>;
  };
  /** E6 recovery of this σ (at this ε for the hybrid), or null without queries. */
  readonly e6: MethodMetrics | null;
}

export interface E7Result {
  readonly runId: number;
  readonly policyVersion: string;
  readonly k: number;
  readonly e3Ks: number[];
  readonly defaults: {
    readonly sigma: SigmaVariant;
    readonly epsilon: number;
    readonly alpha: number;
    readonly scoring: FixScoring;
  };
  readonly epsilons: number[];
  readonly alphas: number[];
  readonly rows: E7Row[];
  /** Top-k Jaccard between every pair of σ variants at the default ε and α. */
  readonly sigmaPairs: {
    readonly a: SigmaVariant;
    readonly b: SigmaVariant;
    readonly jaccard: number;
  }[];
  readonly e6: Pick<E6Result, "options"> & { readonly repeats: number };
}

const E6_OF: Record<Exclude<SigmaVariant, "refGateCosine">, E6Method> = {
  cosineOnly: "cosine",
  refOnly: "ref",
  blended: "blended",
};

/**
 * Pure: E7 from what the run's ranking, E3 and E6 need (the E6 result must carry the hybrid
 * gated at every swept ε: maskingRecovery(…, { gateEpsilons })).
 */
export function ablate(
  inputs: RunInputs,
  policyId: PolicyId,
  e3Data: E3Data,
  e6: E6Result,
): E7Result {
  const { config } = inputs;
  const k = config.fixTopK;
  const settings = e7Settings(config);
  const run = prepareRun(inputs, { policyId });
  const defaults = {
    sigma: config.sigmaVariant,
    epsilon: config.epsilon,
    alpha: config.alpha,
    scoring: config.fixScoring,
  };
  const topOf = (s: Pick<E7Setting, "sigma" | "epsilon" | "alpha" | "scoring">) => {
    const ranked = run.rank(s);
    return { ranked, top: topFixKeys(run, ranked, k) };
  };
  const reference = topOf(defaults).top;

  // S_imp for E3: a pool entry's S times its target's importance (a graph node's, else the
  // detached importance of an orphan's URL).
  const nodes = () => run.importance().nodes;
  const importanceOf = (target: string) =>
    nodes()[target]?.importance ?? importanceCore.detachedImportance(target, config).importance;
  const weighted = (pool: readonly PoolEntry[]): PoolEntry[] =>
    pool.map((e) => ({ ...e, score: e.score * importanceOf(e.target) }));

  // The random baseline depends on the pool (ε, α), not on σ or the scoring.
  const randomCache = new Map<string, Record<number, number>>();
  const rows = settings.map((s): E7Row => {
    const { ranked, top } = topOf(s);
    const e3Inputs = buildE3Inputs(e3Data, s);
    const ordered = rankPool(
      s.scoring === "S_imp" ? weighted(e3Inputs.pool) : e3Inputs.pool,
      "linklens",
    );
    const linklens = Object.fromEntries(
      config.e3TopKs.map((kk) => [
        kk,
        evaluateSelection(e3Inputs, ordered.slice(0, kk)).totalDeltaPr,
      ]),
    );
    const poolKey = `${s.epsilon}|${s.alpha}`;
    let random = randomCache.get(poolKey);
    if (random === undefined) {
      const r = compareE3(e3Inputs, config.e3TopKs, config.e3RandomDraws, config.randomSeed);
      random = Object.fromEntries(
        r.byK.map((b) => [b.k, b.methods.find((m) => m.method === "random")?.totalDeltaPr ?? 0]),
      );
      randomCache.set(poolKey, random);
    }
    const e6Metrics =
      s.sigma === "refGateCosine"
        ? (e6.gatedSummary?.[String(s.epsilon)] ?? null)
        : (e6.summary[E6_OF[s.sigma]] ?? null);
    return {
      ...s,
      fixes: ranked.length,
      topKJaccardDefault: stats.jaccard(top, reference),
      e3: { pool: e3Inputs.pool.length, linklens, random },
      e6: e6Metrics,
    };
  });

  const bySigma = new Map(
    SIGMA_VARIANTS.map((sigma) => [sigma, topOf({ ...defaults, sigma, scoring: "S" }).top]),
  );
  const sigmaPairs: E7Result["sigmaPairs"] = [];
  SIGMA_VARIANTS.forEach((a, i) => {
    for (const b of SIGMA_VARIANTS.slice(i + 1)) {
      sigmaPairs.push({
        a,
        b,
        jaccard: stats.jaccard(bySigma.get(a) as Set<string>, bySigma.get(b) as Set<string>),
      });
    }
  });

  return {
    runId: inputs.runId,
    policyVersion: canonicalise.POLICIES[policyId].version,
    k,
    e3Ks: [...config.e3TopKs],
    defaults,
    epsilons: [...new Set(settings.map((s) => s.epsilon))].sort((a, b) => a - b),
    alphas: [...new Set(settings.map((s) => s.alpha))].sort((a, b) => a - b),
    rows,
    sigmaPairs,
    e6: { options: e6.options, repeats: e6.repeats.length },
  };
}

/** E7 on a stored run: E6 is run once (every swept ε gated), then every setting is ranked. */
export async function runAblation(
  inputs: RunInputs,
  policyId: PolicyId,
  e3Data: E3Data,
  embedder: Embedder,
): Promise<E7Result> {
  const epsilons = e7Settings(inputs.config).map((s) => s.epsilon);
  const e6 = await maskingRecovery(inputs, policyId, embedder, inputs.config.randomSeed, {
    gateEpsilons: [...new Set(epsilons)].sort((a, b) => a - b),
  });
  return ablate(inputs, policyId, e3Data, e6);
}
