import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import {
  SIGMA_VARIANTS,
  type FixScoring,
  type LinkLensConfig,
  type SigmaVariant,
} from "../config.js";
import { importanceFor } from "../importance/run.js";
import { insertArtefact, listArtefacts } from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import { COSINE_ARTEFACT, cosineOf, type CosineMatrix } from "../semantic/cosine.js";
import type { RefVariant } from "../semantic/ref.js";
import {
  loadCandidates,
  type Candidate,
  type CandidateAction,
  type TargetReason,
} from "./candidates.js";
import { COUNTERFACTUAL_ARTEFACT, type CounterfactualResult } from "./counterfactual.js";
import { loadDonorEffort, type DonorEffort } from "./effort.js";

/** Bump whenever the output can change (σ definitions, S, ordering, record fields). */
export const SCORING_VERSION = "scoring@1.2.0";
export const FIX_RANKING_ARTEFACT = "fix-ranking";

type SigmaConfig = Pick<LinkLensConfig, "epsilon" | "sigmaBlendLambda">;

/**
 * Every σ(u,v) variant for one pair. A missing cosine (no embedding for either page) counts as 0.
 * - cosineOnly: cos(u,v)
 * - refOnly: REF(u,v)
 * - refGateCosine: cos(u,v) if REF(u,v) > ε, else 0 (the default)
 * - blended: λ·REF(u,v) + (1 − λ)·cos(u,v)
 */
export function sigmaValues(
  ref: number,
  cosine: number | null,
  config: SigmaConfig,
): Record<SigmaVariant, number> {
  const cos = cosine ?? 0;
  const lambda = config.sigmaBlendLambda;
  return {
    cosineOnly: cos,
    refOnly: ref,
    refGateCosine: ref > config.epsilon ? cos : 0,
    blended: lambda * ref + (1 - lambda) * cos,
  };
}

/** S(u→v) = ΔPR_v × σ(u,v) / κ(u). */
export const fixScore = (deltaPr: number, sigma: number, kappa: number) =>
  (deltaPr * sigma) / kappa;

/** S_imp(u→v) = S(u→v) × importance(v) (L12; experimental, off by default). */
export const importanceScore = (s: number, importance: number) => s * importance;

export interface FixRecord {
  /** The candidate id: `${type}:${donor}->${target}`. */
  readonly id: string;
  readonly donor: string;
  readonly target: string;
  readonly type: CandidateAction;
  /** PR(v) before and after the fix; ΔPR_v; and the site-wide L1 change. */
  readonly prBefore: number;
  readonly prAfter: number;
  readonly deltaPr: number;
  readonly deltaPrL1: number;
  readonly deltaDepth: number | null;
  readonly depthBefore: number | null;
  readonly depthAfter: number | null;
  /** The σ used for the score, and every variant's value (E7). */
  readonly sigmaVariant: SigmaVariant;
  readonly sigma: number;
  readonly sigmas: Record<SigmaVariant, number>;
  readonly ref: number;
  readonly rho: number;
  /** cos(u,v) of the page embeddings; null when either page has none. */
  readonly cosine: number | null;
  /** The existing link's ω (null if none) and the link weight before and after the fix. */
  readonly prominence: {
    readonly omega: number | null;
    readonly weightBefore: number;
    readonly weightAfter: number;
  };
  readonly kappa: number;
  readonly templateReach: number;
  /** The ranking score: S, or S_imp = S × importance(target) when `scoring` is "S_imp". */
  readonly score: number;
  /** S(u→v) = ΔPR_v × σ / κ, whatever the scoring mode. */
  readonly scoreS: number;
  readonly scoring: FixScoring;
  /** importance(target) in [0, 1] (L12); null when the ranking did not use it (mode "S"). */
  readonly importance: number | null;
  /** 1-based, over all fixes. */
  readonly rank: number;
  /** 1-based, among the fixes for the same target. */
  readonly targetRank: number;
  readonly targetReasons: TargetReason[];
  readonly diagnosis: "v4" | "v3" | null;
  readonly policyVersion: string;
}

export interface ScoringInput {
  readonly policyVersion: string;
  readonly candidates: readonly Candidate[];
  /** One counterfactual result per candidate (matched by candidate id). */
  readonly results: readonly CounterfactualResult[];
  /** cos(u,v), or null when unknown. */
  readonly cosine: (u: string, v: string) => number | null;
  readonly effort: ReadonlyMap<string, Pick<DonorEffort, "kappa" | "templateReach">>;
  /** importance(v) of a target (L12): needed only when scoring is "S_imp". */
  readonly importance?: (node: string) => number | null;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Ranking order: score (highest first), then ΔPR_v, then donor and target. */
const byRank = (
  a: Omit<FixRecord, "rank" | "targetRank">,
  b: Omit<FixRecord, "rank" | "targetRank">,
) => b.score - a.score || b.deltaPr - a.deltaPr || cmp(a.donor, b.donor) || cmp(a.target, b.target);

/**
 * Pure: score every candidate with S(u→v) = ΔPR_v × σ(u,v) / κ(u), or with S_imp = S ×
 * importance(v) when `fixScoring` is "S_imp", and rank them, globally and per target. Returns the
 * fixes in global rank order.
 */
export function scoreFixes(
  input: ScoringInput,
  config: SigmaConfig & {
    readonly sigmaVariant: SigmaVariant;
    readonly fixScoring?: FixScoring;
  },
): FixRecord[] {
  const scoring = config.fixScoring ?? "S";
  const importanceOf = (target: string): number | null => {
    if (scoring !== "S_imp") return null;
    const x = input.importance?.(target) ?? null;
    if (x === null) throw new Error(`S_imp scoring needs importance(${target})`);
    return x;
  };
  const results = new Map(input.results.map((r) => [r.candidateId, r]));
  const unranked = input.candidates.map((c): Omit<FixRecord, "rank" | "targetRank"> => {
    const r = results.get(c.id);
    if (r === undefined) throw new Error(`no counterfactual result for candidate ${c.id}`);
    const effort = input.effort.get(c.donor);
    if (effort === undefined) throw new Error(`no editing effort for donor ${c.donor}`);
    const cosine = input.cosine(c.donor, c.target);
    const sigmas = sigmaValues(c.ref, cosine, config);
    const sigma = sigmas[config.sigmaVariant];
    const scoreS = fixScore(r.deltaPrTarget, sigma, effort.kappa);
    const importance = importanceOf(c.target);
    return {
      id: c.id,
      donor: c.donor,
      target: c.target,
      type: c.action,
      prBefore: r.prBefore,
      prAfter: r.prAfter,
      deltaPr: r.deltaPrTarget,
      deltaPrL1: r.deltaPrL1,
      deltaDepth: r.deltaDepth,
      depthBefore: r.depthBefore,
      depthAfter: r.depthAfter,
      sigmaVariant: config.sigmaVariant,
      sigma,
      sigmas,
      ref: c.ref,
      rho: c.rho,
      cosine,
      prominence: {
        omega: c.existingLink?.omega ?? null,
        weightBefore: r.weightBefore,
        weightAfter: r.weightAfter,
      },
      kappa: effort.kappa,
      templateReach: effort.templateReach,
      score: importance === null ? scoreS : importanceScore(scoreS, importance),
      scoreS,
      scoring,
      importance,
      targetReasons: c.targetReasons,
      diagnosis: c.diagnosis,
      policyVersion: input.policyVersion,
    };
  });
  if (results.size !== input.candidates.length) {
    throw new Error(
      `${results.size} counterfactual results for ${input.candidates.length} candidates`,
    );
  }
  unranked.sort(byRank);
  const perTarget = new Map<string, number>();
  return unranked.map((f, i) => {
    const t = (perTarget.get(f.target) ?? 0) + 1;
    perTarget.set(f.target, t);
    return { ...f, rank: i + 1, targetRank: t };
  });
}

/** The k best fixes overall (from a ranked list). */
export const topK = <F>(fixes: readonly F[], k: number): F[] => fixes.slice(0, k);

/** The k best fixes for each target, targets in the order of their best fix. */
export function topKPerTarget<F extends { readonly target: string }>(
  fixes: readonly F[],
  k: number,
): Map<string, F[]> {
  const out = new Map<string, F[]>();
  for (const f of fixes) {
    const list = out.get(f.target) ?? [];
    if (list.length === 0) out.set(f.target, list);
    if (list.length < k) list.push(f);
  }
  return out;
}

export interface FixRanking {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly sigmaVariant: SigmaVariant;
  /** "S" (default) or "S_imp" (L12). Rankings stored before scoring@1.2.0 lack it: "S". */
  readonly scoring: FixScoring;
  readonly lambda: number;
  readonly epsilon: number;
  readonly sources: {
    readonly counterfactualArtefactId: number;
    readonly counterfactualVersion: string;
    readonly cosineArtefactId: number;
    readonly cosineModel: string;
    readonly candidatesVersion: string;
    readonly refVariant: RefVariant;
  };
  readonly counts: { readonly fixes: number; readonly targets: number };
  /** Every fix, in global rank order. */
  readonly fixes: FixRecord[];
}

export interface PersistedFixRanking extends FixRanking {
  readonly artefact: ArtefactRow;
}

/** The counterfactual artefact's fields scoring needs (see packages/counterfactual). */
interface StoredCounterfactual {
  readonly version: string;
  readonly candidatesVersion: string;
  readonly refVariant: RefVariant;
  readonly results: CounterfactualResult[];
}

async function latest<P>(db: Queryable, runId: number, policyVersion: string, kind: string) {
  const rows = await listArtefacts(db, runId, { kind, policyVersion });
  const row = rows.at(-1);
  return row === undefined ? null : { id: row.id, payload: row.payload as unknown as P };
}

/**
 * Rank the fixes of a run under `policyId` with `sigmaVariant` (default config.sigmaVariant):
 * ΔPR and Δdepth from the run's latest `counterfactual` artefact, cosine from its latest
 * `cosine-matrix` artefact, REF and prominence from the fix candidates (recomputed, matched by
 * candidate id) and κ from the donors' pages. Appended as a `fix-ranking` artefact.
 */
export async function buildFixRanking(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
  options: { readonly sigmaVariant?: SigmaVariant; readonly scoring?: FixScoring } = {},
): Promise<PersistedFixRanking> {
  const policyVersion = POLICIES[policyId].version;
  const [cf, cos] = await Promise.all([
    latest<StoredCounterfactual>(db, runId, policyVersion, COUNTERFACTUAL_ARTEFACT),
    latest<CosineMatrix>(db, runId, policyVersion, COSINE_ARTEFACT),
  ]);
  if (cf === null) {
    throw new Error(`run ${runId} has no ${policyVersion} counterfactual artefact: run it first`);
  }
  if (cos === null) {
    throw new Error(`run ${runId} has no ${policyVersion} cosine-matrix artefact: run it first`);
  }
  const [{ list, config }, effort] = await Promise.all([
    loadCandidates(db, runId, policyId, cf.payload.refVariant),
    loadDonorEffort(db, runId, policyId),
  ]);
  if (list.version !== cf.payload.candidatesVersion) {
    throw new Error(
      `candidates are ${list.version} but the counterfactual used ${cf.payload.candidatesVersion}`,
    );
  }
  const sigmaVariant = options.sigmaVariant ?? config.sigmaVariant;
  if (!SIGMA_VARIANTS.includes(sigmaVariant)) throw new Error(`unknown σ variant ${sigmaVariant}`);
  const scoring = options.scoring ?? config.fixScoring;
  const importance = scoring === "S_imp" ? (await importanceFor(db, runId, policyId)).nodes : null;
  const fixes = scoreFixes(
    {
      policyVersion,
      candidates: list.candidates,
      results: cf.payload.results,
      cosine: (u, v) => cosineOf(cos.payload, u, v),
      effort,
      ...(importance === null
        ? {}
        : { importance: (node: string) => importance[node]?.importance ?? null }),
    },
    { ...config, sigmaVariant, fixScoring: scoring },
  );
  const ranking: FixRanking = {
    version: SCORING_VERSION,
    runId,
    policyVersion,
    sigmaVariant,
    scoring,
    lambda: config.sigmaBlendLambda,
    epsilon: config.epsilon,
    sources: {
      counterfactualArtefactId: cf.id,
      counterfactualVersion: cf.payload.version,
      cosineArtefactId: cos.id,
      cosineModel: cos.payload.model,
      candidatesVersion: list.version,
      refVariant: cf.payload.refVariant,
    },
    counts: { fixes: fixes.length, targets: new Set(fixes.map((f) => f.target)).size },
    fixes,
  };
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion,
    kind: FIX_RANKING_ARTEFACT,
    payload: ranking as unknown as Json,
  });
  return { ...ranking, artefact };
}
