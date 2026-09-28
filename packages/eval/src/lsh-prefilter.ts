import { performance } from "node:perf_hooks";
import { canonicalise, db as q, semantic, text, type LinkLensConfig } from "@linklens/core";

type PolicyId = canonicalise.PolicyId;
type RefVariant = semantic.RefVariant;

/**
 * The LSH Ensemble REF pre-filter against exact REF, at several page caps.
 *
 * One crawl at the largest cap stands for every smaller cap: with BFS and one worker, a crawl
 * admits and fetches URLs in the same order whatever its cap, so a cap-N crawl is the first N
 * admitted URLs of the large one. A cap keeps the policy's documents whose representative page
 * was among them, and the text model (IDF, boilerplate) is rebuilt at that cap.
 *
 * Per cap and REF variant: the ground truth is every pair with REF > ε, from the exact inverted
 * index (`refMatrixPrepared`), checked against a brute-force all-pairs loop (`ref()` per pair).
 * The LSH index (MinHash of each donor's S_A, the ensemble) is built once per cap; each threshold
 * of `lshEvalThresholds` queries it with every target's S_B, and the candidates are scored
 * exactly. Reported: candidate recall (true pairs found), REF-mass recall, recall of each
 * target's top `candidateMaxPerTarget` donors by REF (what fix candidates use), precision and
 * the share of all pairs scored; and the runtimes (median of `lshEvalRepeats`, brute force once).
 */

export const LSH_EXPERIMENT_VERSION = "lsh-prefilter@1.0.0";

export interface CapDocuments {
  readonly documents: text.RawDocument[];
  /** Admission rank (0-based) of each document's representative page. */
  readonly rank: Map<string, number>;
  readonly admitted: number;
  readonly policyVersion: string;
  readonly config: Readonly<LinkLensConfig>;
}

/** Each crawl URL's admission rank: the order of first attempts (BFS, one worker). */
export function admissionRanks(
  fetches: readonly Pick<q.FetchRow, "id" | "requestedUrl" | "purpose">[],
) {
  const rank = new Map<string, number>();
  for (const f of [...fetches].sort((a, b) => a.id - b.id)) {
    if (f.purpose !== "crawl" || rank.has(f.requestedUrl)) continue;
    rank.set(f.requestedUrl, rank.size);
  }
  return rank;
}

/** A run's documents under `policyId`, each with its representative page's admission rank. */
export async function loadCapDocuments(
  db: q.Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<CapDocuments> {
  const [{ documents, policyVersion, config }, fetches] = await Promise.all([
    text.loadRunDocuments(db, runId, policyId),
    q.listFetches(db, runId),
  ]);
  const byUrl = admissionRanks(fetches);
  const urlOf = new Map(fetches.map((f) => [f.id, f.requestedUrl]));
  const rank = new Map<string, number>();
  for (const d of documents) {
    const r = byUrl.get(urlOf.get(d.fetchId) ?? "");
    if (r === undefined) throw new Error(`run ${runId}: no crawl fetch for document ${d.node}`);
    rank.set(d.node, r);
  }
  return { documents, rank, admitted: byUrl.size, policyVersion, config };
}

/** The documents a cap-N crawl would have: representative page among the first N admitted. */
export function capDocuments(
  documents: readonly text.RawDocument[],
  rank: ReadonlyMap<string, number>,
  cap: number,
): text.RawDocument[] {
  return documents.filter((d) => (rank.get(d.node) ?? Infinity) < cap);
}

/** Brute force: REF of every ordered pair by `semantic.ref` on sets, no index. */
export function bruteForceRef(
  model: text.TextModel,
  variant: RefVariant,
  epsilon: number,
): Map<string, number> {
  const docs = [...model.documents].sort((a, b) =>
    a.node < b.node ? -1 : a.node > b.node ? 1 : 0,
  );
  const donors = docs.map((d) => new Set(d.donor));
  const targets = docs.map((d) => semantic.targetWeights(d));
  const out = new Map<string, number>();
  for (let u = 0; u < docs.length; u++) {
    for (let v = 0; v < docs.length; v++) {
      if (u === v) continue;
      const r = semantic.ref(donors[u] as Set<string>, targets[v] as Map<string, number>, variant);
      if (r > epsilon) out.set(`${u}:${v}`, r);
    }
  }
  return out;
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** Median wall time (ms) of `repeats` runs of `f`, and its last result. */
function timed<T>(repeats: number, f: () => T): { ms: number; value: T } {
  const times: number[] = [];
  let value: T | undefined;
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    value = f();
    times.push(performance.now() - t0);
  }
  return { ms: median(times), value: value as T };
}

export interface ThresholdResult {
  readonly threshold: number;
  readonly candidates: number;
  /** candidates / all ordered pairs. */
  readonly candidateShare: number;
  readonly found: number;
  readonly recall: number | null;
  readonly massRecall: number | null;
  /** Recall of each target's top candidateMaxPerTarget donors by exact REF. */
  readonly topRecall: number | null;
  /** True pairs among the candidates / candidates. */
  readonly precision: number | null;
  readonly ms: { readonly query: number; readonly verify: number; readonly total: number };
}

export interface VariantResult {
  readonly variant: RefVariant;
  /** Pairs with REF > ε (exact). */
  readonly truePairs: number;
  readonly bruteForceMatches: boolean;
  readonly ms: { readonly exact: number; readonly bruteForce: number };
  readonly thresholds: ThresholdResult[];
}

export interface CapResult {
  readonly cap: number;
  readonly documents: number;
  readonly pairs: number;
  /** Mean |S_A| (donor terms that are in some target) and |S_B|. */
  readonly meanDonorTerms: number;
  readonly meanTargetTerms: number;
  /** Shared LSH steps (the index does not depend on the variant or the threshold). */
  readonly ms: {
    readonly textModel: number;
    readonly prepare: number;
    readonly hash: number;
    readonly signatures: number;
    readonly index: number;
  };
  readonly variants: VariantResult[];
}

export interface CapOptions {
  readonly variants: readonly RefVariant[];
  /** Skip the brute-force loop (its time is then null-like: NaN). */
  readonly bruteForce: boolean;
}

/** Pure but for the clock: the experiment at one cap. */
export function evaluateCap(
  documents: readonly text.RawDocument[],
  cap: number,
  meta: { readonly runId: number; readonly policyVersion: string },
  config: Readonly<LinkLensConfig>,
  options: CapOptions = { variants: ["weighted", "unweighted"], bruteForce: true },
): CapResult {
  const repeats = config.lshEvalRepeats;
  const { value: model, ms: textModelMs } = timed(1, () =>
    text.buildTextModel(
      { runId: meta.runId, policyVersion: meta.policyVersion, documents },
      config,
    ),
  );
  const n = model.documents.length;
  const pairs = n * Math.max(n - 1, 0);

  // The LSH side is variant-independent: S_A and S_B are the same term sets in both variants.
  const { value: base, ms: prepareMs } = timed(repeats, () =>
    semantic.prepareRef(model, "weighted"),
  );
  const params = semantic.lshParams(config);
  const { value: sets, ms: hashMs } = timed(repeats, () => semantic.lshSets(base));
  const family = semantic.hashFamily(params.numPerm, params.seed);
  const { value: sigs, ms: sigMs } = timed(repeats, () => ({
    donors: sets.donors.map((s) => semantic.minhash(s, family)),
    targets: sets.targets.map((s) => semantic.minhash(s, family)),
  }));
  const { value: index, ms: indexMs } = timed(repeats, () =>
    semantic.buildLshEnsemble(sets.donors, params, sigs.donors),
  );
  const perThreshold = config.lshEvalThresholds.map((threshold) => {
    const { value: perTarget, ms } = timed(repeats, () => {
      // Queries tune (b, r) per partition and size bin; a fresh cache each time, so it is timed.
      index.tuned.clear();
      return sets.targets.map((t, v) =>
        semantic.queryLshEnsemble(index, sigs.targets[v] as Uint32Array, t.length, threshold),
      );
    });
    return { threshold, queryMs: ms, ...semantic.candidatesByDonor(perTarget, n) };
  });

  const variants = options.variants.map((variant): VariantResult => {
    const prep = variant === "weighted" ? base : semantic.prepareRef(model, variant);
    const { value: exact, ms: exactMs } = timed(repeats, () =>
      semantic.refMatrixPrepared(prep, config),
    );
    const truth = new Map(exact.entries.map((e) => [`${e.source}:${e.target}`, e.ref]));
    let bruteMs = Number.NaN;
    let matches = true;
    if (options.bruteForce) {
      const brute = timed(1, () => bruteForceRef(model, variant, config.epsilon));
      bruteMs = brute.ms;
      matches =
        brute.value.size === truth.size &&
        [...brute.value].every(([k, r]) => Math.abs((truth.get(k) ?? -1) - r) <= 1e-12);
    }
    const massTotal = [...truth.values()].reduce((s, r) => s + r, 0);
    // Each target's top donors by exact REF (ties by donor index), as fix candidates keep them.
    const byTarget = new Map<number, { u: number; ref: number }[]>();
    for (const e of exact.entries) {
      const list = byTarget.get(e.target) ?? [];
      list.push({ u: e.source, ref: e.ref });
      byTarget.set(e.target, list);
    }
    const top = new Set<string>();
    for (const [v, list] of byTarget) {
      list.sort((a, b) => b.ref - a.ref || a.u - b.u);
      for (const { u } of list.slice(0, config.candidateMaxPerTarget)) top.add(`${u}:${v}`);
    }

    const thresholds = perThreshold.map((t): ThresholdResult => {
      const { value: m, ms: verifyMs } = timed(repeats, () =>
        semantic.refMatrixPrepared(prep, config, t.byDonor),
      );
      const keys = m.entries.map((e) => `${e.source}:${e.target}`);
      const found = keys.filter((k) => truth.has(k)).length;
      const mass = m.entries.reduce((s, e) => s + e.ref, 0);
      const topFound = keys.filter((k) => top.has(k)).length;
      return {
        threshold: t.threshold,
        candidates: t.pairs,
        candidateShare: pairs === 0 ? 0 : t.pairs / pairs,
        found,
        recall: truth.size === 0 ? null : found / truth.size,
        massRecall: massTotal === 0 ? null : mass / massTotal,
        topRecall: top.size === 0 ? null : topFound / top.size,
        precision: t.pairs === 0 ? null : found / t.pairs,
        ms: {
          query: t.queryMs,
          verify: verifyMs,
          total: prepareMs + hashMs + sigMs + indexMs + t.queryMs + verifyMs,
        },
      };
    });
    return {
      variant,
      truePairs: truth.size,
      bruteForceMatches: matches,
      ms: { exact: prepareMs + exactMs, bruteForce: bruteMs },
      thresholds,
    };
  });

  const mean = (xs: readonly { length: number }[]) =>
    xs.length === 0 ? 0 : xs.reduce((s, x) => s + x.length, 0) / xs.length;
  return {
    cap,
    documents: n,
    pairs,
    meanDonorTerms: mean(base.donorIds),
    meanTargetTerms: mean(base.tIds),
    ms: {
      textModel: textModelMs,
      prepare: prepareMs,
      hash: hashMs,
      signatures: sigMs,
      index: indexMs,
    },
    variants,
  };
}

// ---------- tidy rows (the contract with analysis/linklens_analysis/lsh.py) ----------

export const LSH_COLUMNS = [
  "site_id",
  "run_id",
  "policy_version",
  "cap",
  "documents",
  "variant",
  "threshold",
  "metric",
  "value",
] as const;
export type LshRow = Record<(typeof LSH_COLUMNS)[number], string | number | null>;

/** One row per site × cap × (variant) × (threshold) × metric; empty cells where n/a. */
export function lshRows(
  site: { readonly siteId: string; readonly runId: number; readonly policyVersion: string },
  r: CapResult,
): LshRow[] {
  const rows: LshRow[] = [];
  const push = (
    variant: RefVariant | null,
    threshold: number | null,
    metric: string,
    value: number | null,
  ) => {
    if (value === null || !Number.isFinite(value)) return;
    rows.push({
      site_id: site.siteId,
      run_id: site.runId,
      policy_version: site.policyVersion,
      cap: r.cap,
      documents: r.documents,
      variant,
      threshold,
      metric,
      value,
    });
  };
  push(null, null, "pairs", r.pairs);
  push(null, null, "mean_donor_terms", r.meanDonorTerms);
  push(null, null, "mean_target_terms", r.meanTargetTerms);
  push(null, null, "ms_text_model", r.ms.textModel);
  push(null, null, "ms_prepare", r.ms.prepare);
  push(null, null, "ms_hash", r.ms.hash);
  push(null, null, "ms_signatures", r.ms.signatures);
  push(null, null, "ms_index", r.ms.index);
  for (const v of r.variants) {
    push(v.variant, null, "true_pairs", v.truePairs);
    push(v.variant, null, "brute_force_matches", v.bruteForceMatches ? 1 : 0);
    push(v.variant, null, "ms_exact", v.ms.exact);
    push(v.variant, null, "ms_brute_force", v.ms.bruteForce);
    for (const t of v.thresholds) {
      push(v.variant, t.threshold, "candidates", t.candidates);
      push(v.variant, t.threshold, "candidate_share", t.candidateShare);
      push(v.variant, t.threshold, "found", t.found);
      push(v.variant, t.threshold, "recall", t.recall);
      push(v.variant, t.threshold, "mass_recall", t.massRecall);
      push(v.variant, t.threshold, "top_recall", t.topRecall);
      push(v.variant, t.threshold, "precision", t.precision);
      push(v.variant, t.threshold, "ms_query", t.ms.query);
      push(v.variant, t.threshold, "ms_verify", t.ms.verify);
      push(v.variant, t.threshold, "ms_lsh_total", t.ms.total);
    }
  }
  return rows;
}
