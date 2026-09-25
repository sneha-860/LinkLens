import type { LinkLensConfig } from "../config.js";
import type { PolicyId } from "../canonicalise/index.js";
import { insertArtefact } from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import { loadProminence } from "../prominence/run.js";
import type { ProminenceEdge } from "../prominence/weights.js";
import { refMatrix, type MatchedTerm, type RefMatrix, type RefVariant } from "../semantic/ref.js";
import { loadTextModel } from "../text/run.js";

/** Bump whenever the output can change (case rules, severity, pair set, recommendations). */
export const DIAGNOSIS_VERSION = "diagnosis@1.0.0";
export const DIAGNOSIS_ARTEFACT = "diagnosis";

/** In report order: the actionable cases first. */
export const CASES = ["v4", "v3", "v1", "v2"] as const;
export type DiagnosisCase = (typeof CASES)[number];

export const CASE_LABELS: Readonly<Record<DiagnosisCase, string>> = {
  v4: "missing",
  v3: "buried",
  v2: "good",
  v1: "misleading/low-value",
};

export type Recommendation = "add-link" | "make-more-visible" | "flag-for-review";

export const RECOMMENDATIONS: Readonly<Record<DiagnosisCase, Recommendation | null>> = {
  v4: "add-link",
  v3: "make-more-visible",
  v1: "flag-for-review",
  v2: null,
};

/**
 * Whether fix simulation may act on the case: v4 and v3 change the graph; v1 is only ever
 * flagged for a human (never simulated); v2 needs nothing.
 */
export const SIMULATE: Readonly<Record<DiagnosisCase, boolean>> = {
  v4: true,
  v3: true,
  v1: false,
  v2: false,
};

/**
 * The patent's four cases, for a pair with semantic weight ρ and link prominence ω:
 * - v4 missing: ρ > α and there is no link u→v
 * - v3 buried: ρ > α, a link exists, ω < α
 * - v2 good: ρ > α, ω ≥ α
 * - v1 misleading/low-value: ρ ≤ α, ω ≥ α
 * Otherwise (ρ ≤ α and ω < α) the pair is unclassified.
 */
export function classify(
  rho: number,
  omega: number,
  hasEdge: boolean,
  alpha: number,
): DiagnosisCase | null {
  if (rho > alpha) {
    if (!hasEdge) return "v4";
    return omega < alpha ? "v3" : "v2";
  }
  return hasEdge && omega >= alpha ? "v1" : null;
}

export interface Diagnosis {
  /** Stable id: `${case}:${source}->${target}`. */
  readonly id: string;
  readonly case: DiagnosisCase;
  readonly label: string;
  readonly source: string;
  readonly target: string;
  /** REF(u,v) (0 when REF ≤ ε), ρ(u,v) and ω(u,v) (0 without a link). */
  readonly ref: number;
  readonly rho: number;
  readonly omega: number;
  /** |ω(u,v) − ρ(u,v)|. */
  readonly severity: number;
  readonly recommendation: Recommendation | null;
  readonly simulate: boolean;
  /** The existing link u→v, if any. */
  readonly edge: Pick<ProminenceEdge, "weight" | "observations" | "origin" | "regions"> | null;
  /** The matched n-grams behind REF (for explanations); empty when REF ≤ ε. */
  readonly matched: MatchedTerm[];
}

export type DiagnosisCounts = Record<DiagnosisCase, number> & {
  /** Pairs considered: REF > ε or a link, both ends with a text document, u ≠ v. */
  readonly pairs: number;
  /** ρ ≤ α and ω < α: none of the four cases. */
  readonly unclassified: number;
  /** Links whose source or target has no text document (not crawled as HTML): not judged. */
  readonly skippedNoText: number;
};

export interface DiagnosisReport {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly refVersion: string;
  readonly refVariant: RefVariant;
  readonly prominenceVersion: string;
  readonly alpha: number;
  readonly epsilon: number;
  readonly counts: DiagnosisCounts;
  /** Case order (v4, v3, v1, v2), then severity (highest first), then source, target. */
  readonly diagnoses: Diagnosis[];
}

export interface DiagnoseInput {
  readonly ref: RefMatrix;
  readonly prominence: {
    readonly version: string;
    readonly runId: number;
    readonly policyVersion: string;
    readonly edges: readonly ProminenceEdge[];
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pure: diagnose every pair (u,v), u ≠ v, with REF(u,v) > ε or a link u→v. ρ comes from the REF
 * matrix (0 when REF ≤ ε), ω from prominence (0 without a link). Pairs are judged only when both
 * ends have a text document; other links are counted as skippedNoText.
 */
export function diagnose(
  input: DiagnoseInput,
  config: Pick<LinkLensConfig, "alpha">,
): DiagnosisReport {
  const { ref, prominence } = input;
  if (ref.runId !== prominence.runId || ref.policyVersion !== prominence.policyVersion) {
    throw new Error(
      `REF (run ${ref.runId}, ${ref.policyVersion}) and prominence (run ${prominence.runId}, ` +
        `${prominence.policyVersion}) must come from the same run and policy`,
    );
  }
  const alpha = config.alpha;
  const hasText = new Set(ref.nodes);
  const key = (s: string, t: string) => JSON.stringify([s, t]);

  const refs = new Map<string, RefMatrix["entries"][number]>();
  for (const e of ref.entries) {
    refs.set(key(ref.nodes[e.source] as string, ref.nodes[e.target] as string), e);
  }
  const edges = new Map<string, ProminenceEdge>();
  let skippedNoText = 0;
  for (const e of prominence.edges) {
    if (e.source === e.target) continue;
    if (!hasText.has(e.source) || !hasText.has(e.target)) {
      skippedNoText += 1;
      continue;
    }
    edges.set(key(e.source, e.target), e);
  }

  const pairs = new Map<string, [string, string]>();
  for (const e of ref.entries) {
    const s = ref.nodes[e.source] as string;
    const t = ref.nodes[e.target] as string;
    pairs.set(key(s, t), [s, t]);
  }
  for (const e of edges.values()) pairs.set(key(e.source, e.target), [e.source, e.target]);

  const counts = { v4: 0, v3: 0, v2: 0, v1: 0, unclassified: 0 };
  const diagnoses: Diagnosis[] = [];
  for (const [k, [source, target]] of pairs) {
    const r = refs.get(k);
    const e = edges.get(k);
    const rho = r?.rho ?? 0;
    const omega = e?.omega ?? 0;
    const c = classify(rho, omega, e !== undefined, alpha);
    if (c === null) {
      counts.unclassified += 1;
      continue;
    }
    counts[c] += 1;
    diagnoses.push({
      id: `${c}:${source}->${target}`,
      case: c,
      label: CASE_LABELS[c],
      source,
      target,
      ref: r?.ref ?? 0,
      rho,
      omega,
      severity: Math.abs(omega - rho),
      recommendation: RECOMMENDATIONS[c],
      simulate: SIMULATE[c],
      edge:
        e === undefined
          ? null
          : {
              weight: e.weight,
              observations: e.observations,
              origin: e.origin,
              regions: e.regions,
            },
      matched: r?.matched ?? [],
    });
  }

  const order = new Map(CASES.map((c, i) => [c, i]));
  diagnoses.sort(
    (a, b) =>
      (order.get(a.case) as number) - (order.get(b.case) as number) ||
      b.severity - a.severity ||
      cmp(a.source, b.source) ||
      cmp(a.target, b.target),
  );

  return {
    version: DIAGNOSIS_VERSION,
    runId: ref.runId,
    policyVersion: ref.policyVersion,
    refVersion: ref.version,
    refVariant: ref.variant,
    prominenceVersion: prominence.version,
    alpha,
    epsilon: ref.epsilon,
    counts: { ...counts, pairs: pairs.size, skippedNoText },
    diagnoses,
  };
}

export interface PersistedDiagnosis extends DiagnosisReport {
  readonly artefact: ArtefactRow;
}

/**
 * Diagnose a run under `policyId` with the run's stored config: the REF matrix (`variant`) and
 * prominence are computed in memory, and the report is appended as a `diagnosis` artefact.
 */
export async function buildDiagnosisRun(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
  variant: RefVariant = "weighted",
): Promise<PersistedDiagnosis> {
  const [{ model, config }, prominence] = await Promise.all([
    loadTextModel(db, runId, policyId),
    loadProminence(db, runId, policyId),
  ]);
  const report = diagnose({ ref: refMatrix(model, variant, config), prominence }, config);
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion: report.policyVersion,
    kind: DIAGNOSIS_ARTEFACT,
    payload: report as unknown as Json,
  });
  return { ...report, artefact };
}
