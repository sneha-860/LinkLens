import { defaultConfig, type LinkLensConfig } from "../config.js";
import type { PolicyId } from "../canonicalise/index.js";
import { insertArtefact } from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import { viewWeights, type TextDocument, type TextModel } from "../text/model.js";
import { loadTextModel } from "../text/run.js";
import {
  buildLshEnsemble,
  hashTerm,
  minhash,
  queryLshEnsemble,
  type LshParams,
} from "./lsh-ensemble.js";

/** Bump whenever the output can change (formula, cutoff, normalisation, explanation). */
export const REF_VERSION = "ref@1.2.0";
export const REF_ARTEFACT = "ref-matrix";

/**
 * weighted: Σ_{t ∈ S_A ∩ S_B} w_B(t) / Σ_{t ∈ S_B} w_B(t), with the target's TF-IDF weights
 * (a few rare, heavy terms of a short target are not matched by chance as easily).
 * unweighted: |S_A ∩ S_B| / |S_B|, the patent's set form (for the σ ablation).
 */
export const REF_VARIANTS = ["weighted", "unweighted"] as const;
export type RefVariant = (typeof REF_VARIANTS)[number];

/** S_A of the donor: a set of terms. */
export type DonorSet = ReadonlySet<string>;
/** S_B of the target with its weights w_B. */
export type TargetWeights = ReadonlyMap<string, number>;

/** REF(A,B) for one pair; 0 when S_B is empty (or has no weight). */
export function ref(donor: DonorSet, target: TargetWeights, variant: RefVariant): number {
  let matched = 0;
  let total = 0;
  for (const [t, w] of target) {
    const x = variant === "weighted" ? w : 1;
    total += x;
    if (donor.has(t)) matched += x;
  }
  return total > 0 ? matched / total : 0;
}

export interface MatchedTerm {
  readonly term: string;
  /** This term's share of REF: w_B(t) / Σ w_B (weighted) or 1 / |S_B| (unweighted). */
  readonly contribution: number;
}

export interface RefEntry {
  /** Index into `nodes` of the donor u. */
  readonly source: number;
  /** Index into `nodes` of the target v. */
  readonly target: number;
  /** REF(u,v) > ε. */
  readonly ref: number;
  /** ρ(u,v) = REF(u,v) / Σ_w REF(u,w) over u's entries: each source's row sums to 1. */
  readonly rho: number;
  /** How many of S_B's terms S_A contains. */
  readonly matchedCount: number;
  /** The refExplainTerms matched n-grams with the largest contribution (ties by term). */
  readonly matched: MatchedTerm[];
}

export interface RefMatrix {
  readonly version: string;
  readonly textVersion: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly variant: RefVariant;
  readonly epsilon: number;
  readonly explainTerms: number;
  /** The candidate pre-filter used (null: every pair scored, exact). */
  readonly prefilter: RefPrefilterInfo | null;
  /** Document nodes, sorted; entries refer to them by index. */
  readonly nodes: string[];
  readonly stats: {
    readonly nodes: number;
    /** Ordered pairs u ≠ v. */
    readonly pairs: number;
    /** Pairs with REF > 0 before the ε cutoff (among the candidates, with a pre-filter). */
    readonly nonZero: number;
    /** Pairs with REF > ε (stored). */
    readonly kept: number;
    /** Sources with at least one stored entry. */
    readonly sourcesWithEntries: number;
    /** Largest stored REF, or null. */
    readonly maxRef: number | null;
  };
  /** Sparse (COO), sorted by source then target. Pairs with REF ≤ ε and self-pairs are absent. */
  readonly entries: RefEntry[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A model's documents interned for REF: target terms as integer ids with their weights (in term
 * order), CSR postings from term to targets, and each donor's S_A as the ids of its terms that
 * are in some target (other terms cannot match).
 */
export interface PreparedRef {
  readonly model: TextModel;
  readonly variant: RefVariant;
  /** Documents sorted by node; indices below refer to them. */
  readonly docs: readonly TextDocument[];
  readonly termOf: readonly string[];
  readonly tIds: readonly Int32Array[];
  readonly tW: readonly Float64Array[];
  readonly total: Float64Array;
  readonly off: Int32Array;
  readonly postV: Int32Array;
  readonly postW: Float64Array;
  readonly donorIds: readonly Int32Array[];
}

/** Pure: intern a model's documents for REF (see PreparedRef). */
export function prepareRef(model: TextModel, variant: RefVariant): PreparedRef {
  const docs = [...model.documents].sort((a, b) => cmp(a.node, b.node));
  const n = docs.length;
  const unit = (w: number) => (variant === "weighted" ? w : 1);

  // Intern target terms as integers; each target's terms in term order (so a fully matched
  // target sums in the same order on both sides of the division and scores exactly 1).
  const termId = new Map<string, number>();
  const termOf: string[] = [];
  const tIds: Int32Array[] = [];
  const tW: Float64Array[] = [];
  const total = new Float64Array(n);
  docs.forEach((d, v) => {
    const tw = targetWeights(d);
    const ids = new Int32Array(tw.size);
    const ws = new Float64Array(tw.size);
    let i = 0;
    for (const [t, w] of tw) {
      let id = termId.get(t);
      if (id === undefined) {
        id = termOf.length;
        termId.set(t, id);
        termOf.push(t);
      }
      ids[i] = id;
      ws[i] = unit(w);
      total[v] = (total[v] as number) + unit(w);
      i += 1;
    }
    tIds[v] = ids;
    tW[v] = ws;
  });

  // Postings (CSR): for term id t, targets postV[off[t]..off[t+1]) in index order, with weights.
  const m = termOf.length;
  const off = new Int32Array(m + 1);
  for (const ids of tIds) for (const id of ids) off[id + 1] = (off[id + 1] as number) + 1;
  for (let t = 0; t < m; t++) off[t + 1] = (off[t + 1] as number) + (off[t] as number);
  const postV = new Int32Array(off[m] as number);
  const postW = new Float64Array(off[m] as number);
  const fill = off.slice(0, m);
  for (let v = 0; v < n; v++) {
    const ids = tIds[v] as Int32Array;
    const ws = tW[v] as Float64Array;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as number;
      const at = fill[id] as number;
      postV[at] = v;
      postW[at] = ws[i] as number;
      fill[id] = at + 1;
    }
  }

  // S_A(u) as term ids, in term order; terms in no target cannot match and are left out.
  const donorIds = docs.map((d) => {
    const ids: number[] = [];
    for (const t of d.donor) {
      const id = termId.get(t);
      if (id !== undefined) ids.push(id);
    }
    return Int32Array.from(ids);
  });
  return { model, variant, docs, termOf, tIds, tW, total, off, postV, postW, donorIds };
}

/** How the candidate pairs were chosen (null: every pair, exact). */
export interface RefPrefilterInfo {
  readonly method: "lsh-ensemble";
  readonly threshold: number;
  readonly numPerm: number;
  readonly partitions: number;
  readonly maxRows: number;
  /** Candidate ordered pairs u ≠ v that were scored. */
  readonly candidates: number;
}

type RefConfig = Pick<LinkLensConfig, "epsilon" | "refExplainTerms"> &
  Partial<
    Pick<
      LinkLensConfig,
      | "refPrefilter"
      | "lshNumPerm"
      | "lshPartitions"
      | "lshMaxRows"
      | "lshThreshold"
      | "lshFalsePositiveWeight"
      | "lshFalseNegativeWeight"
      | "randomSeed"
    >
  >;

/**
 * Pure: REF(u,v) for every ordered pair of the model's documents, u ≠ v, with S_A = donor(u)
 * and S_B = target(v). Scores ≤ ε become 0 and are not stored; the rest are normalised per
 * source (ρ) and explained by their matched n-grams.
 *
 * Exact all-pairs, but through an inverted index of target terms, so a donor only touches the
 * targets it shares a term with: O(Σ_u Σ_{t ∈ S_A(u)} |postings(t)|) rather than O(n² · |S|).
 * With `refPrefilter: "lsh-ensemble"`, only the pairs an LSH Ensemble returns are scored
 * (exactly); a pair it misses is absent, as if its REF were ≤ ε.
 */
export function refMatrix(model: TextModel, variant: RefVariant, config: RefConfig): RefMatrix {
  const prep = prepareRef(model, variant);
  if ((config.refPrefilter ?? "none") === "none") return refMatrixPrepared(prep, config);
  const params = lshParams(config);
  const threshold = config.lshThreshold ?? defaultConfig.lshThreshold;
  const { byDonor, pairs } = lshCandidates(prep, params, threshold);
  return refMatrixPrepared(prep, config, byDonor, {
    method: "lsh-ensemble",
    threshold,
    numPerm: params.numPerm,
    partitions: params.partitions,
    maxRows: params.maxRows,
    candidates: pairs,
  });
}

/** The LSH Ensemble parameters of a config (defaults for the keys it lacks). */
export function lshParams(config: RefConfig): LshParams {
  return {
    numPerm: config.lshNumPerm ?? defaultConfig.lshNumPerm,
    partitions: config.lshPartitions ?? defaultConfig.lshPartitions,
    maxRows: config.lshMaxRows ?? defaultConfig.lshMaxRows,
    falsePositiveWeight: config.lshFalsePositiveWeight ?? defaultConfig.lshFalsePositiveWeight,
    falseNegativeWeight: config.lshFalseNegativeWeight ?? defaultConfig.lshFalseNegativeWeight,
    seed: config.randomSeed ?? defaultConfig.randomSeed,
  };
}

/** Each donor's and each target's term set as 32-bit term hashes (for MinHash). */
export function lshSets(prep: PreparedRef): { donors: Uint32Array[]; targets: Uint32Array[] } {
  const hash = Uint32Array.from(prep.termOf, hashTerm);
  const of = (ids: Int32Array) => Uint32Array.from(ids, (id) => hash[id] as number);
  return { donors: prep.donorIds.map(of), targets: prep.tIds.map(of) };
}

/**
 * Candidate pairs from an LSH Ensemble over the donors' S_A, queried with each target's S_B at
 * containment `threshold`: per donor, its candidate targets (sorted, never itself).
 */
export function lshCandidates(
  prep: PreparedRef,
  params: LshParams,
  threshold: number,
): { byDonor: Int32Array[]; pairs: number } {
  const sets = lshSets(prep);
  const index = buildLshEnsemble(sets.donors, params);
  const perTarget = sets.targets.map((t) =>
    queryLshEnsemble(index, minhash(t, index.family), t.length, threshold),
  );
  return candidatesByDonor(perTarget, prep.docs.length);
}

/** Invert per-target candidate donors into per-donor candidate targets (self-pairs dropped). */
export function candidatesByDonor(
  perTarget: readonly (readonly number[])[],
  n: number,
): { byDonor: Int32Array[]; pairs: number } {
  const lists: number[][] = Array.from({ length: n }, () => []);
  let pairs = 0;
  perTarget.forEach((donors, v) => {
    for (const u of donors) {
      if (u === v) continue;
      (lists[u] as number[]).push(v);
      pairs += 1;
    }
  });
  // Targets were visited in increasing order, so each list is sorted.
  return { byDonor: lists.map((l) => Int32Array.from(l)), pairs };
}

/**
 * Pure: the REF matrix of a prepared model, over every pair (exact, through the postings) or
 * only over `candidates` (per donor, sorted target indices), each scored exactly.
 */
export function refMatrixPrepared(
  prep: PreparedRef,
  config: Pick<LinkLensConfig, "epsilon" | "refExplainTerms">,
  candidates?: readonly Int32Array[],
  prefilter: RefPrefilterInfo | null = null,
): RefMatrix {
  const { docs, termOf, tIds, tW, total, off, postV, postW, donorIds } = prep;
  const n = docs.length;
  const k = config.refExplainTerms;
  const m = termOf.length;

  const entries: RefEntry[] = [];
  let nonZero = 0;
  let sourcesWithEntries = 0;
  let maxRef: number | null = null;
  const acc = new Float64Array(n);
  const seen = new Uint8Array(n);
  const mask = new Uint8Array(n);
  const inDonor = new Uint8Array(m);
  for (let u = 0; u < n; u++) {
    const donor = donorIds[u] as Int32Array;
    const row: { v: number; ref: number }[] = [];
    const cands = candidates?.[u];
    // With candidates, walk the postings (masked to them) when that touches fewer entries than
    // scanning each candidate's terms. Both sum the matched weights in term order, so the
    // scores are identical to the exact matrix's either way.
    let walk = cands === undefined;
    if (cands !== undefined) {
      let scan = 0;
      for (const v of cands) scan += (tIds[v] as Int32Array).length;
      let postings = 0;
      for (const t of donor) postings += (off[t + 1] as number) - (off[t] as number);
      walk = postings < scan;
      if (walk) for (const v of cands) mask[v] = 1;
    }
    if (walk) {
      const touched: number[] = [];
      for (const t of donor) {
        for (let p = off[t] as number, end = off[t + 1] as number; p < end; p++) {
          const v = postV[p] as number;
          if (cands !== undefined && mask[v] === 0) continue;
          if (seen[v] === 0) {
            seen[v] = 1;
            touched.push(v);
          }
          acc[v] = (acc[v] as number) + (postW[p] as number);
        }
      }
      if (cands !== undefined) for (const v of cands) mask[v] = 0;
      touched.sort((a, b) => a - b);
      for (const v of touched) {
        const r = (acc[v] as number) / (total[v] as number);
        acc[v] = 0;
        seen[v] = 0;
        if (v === u) continue;
        nonZero += 1;
        if (r > config.epsilon) row.push({ v, ref: r });
      }
    } else {
      // Only the candidates, each scored exactly: Σ w_B over S_B's terms that S_A contains, in
      // S_B's term order (the same order as the division's total).
      for (const t of donor) inDonor[t] = 1;
      for (const v of cands as Int32Array) {
        if (v === u) continue;
        const ids = tIds[v] as Int32Array;
        const ws = tW[v] as Float64Array;
        let s = 0;
        for (let i = 0; i < ids.length; i++) {
          if (inDonor[ids[i] as number] === 1) s += ws[i] as number;
        }
        if (s === 0) continue;
        nonZero += 1;
        const r = s / (total[v] as number);
        if (r > config.epsilon) row.push({ v, ref: r });
      }
      for (const t of donor) inDonor[t] = 0;
    }
    if (row.length === 0) continue;
    sourcesWithEntries += 1;
    const sum = row.reduce((s, x) => s + x.ref, 0);
    for (const t of donor) inDonor[t] = 1;
    for (const { v, ref: r } of row) {
      maxRef = maxRef === null || r > maxRef ? r : maxRef;
      const { matched, count } = topMatched(
        tIds[v] as Int32Array,
        tW[v] as Float64Array,
        inDonor,
        termOf,
        k,
      );
      entries.push({
        source: u,
        target: v,
        ref: r,
        rho: r / sum,
        matchedCount: count,
        matched: matched.map((x) => ({ term: x.term, contribution: x.w / (total[v] as number) })),
      });
    }
    for (const t of donor) inDonor[t] = 0;
  }

  return {
    version: REF_VERSION,
    textVersion: prep.model.version,
    runId: prep.model.runId,
    policyVersion: prep.model.policyVersion,
    variant: prep.variant,
    epsilon: config.epsilon,
    explainTerms: config.refExplainTerms,
    prefilter,
    nodes: docs.map((d) => d.node),
    stats: {
      nodes: n,
      pairs: n * Math.max(n - 1, 0),
      nonZero,
      kept: entries.length,
      sourcesWithEntries,
      maxRef,
    },
    entries,
  };
}

/**
 * The k matched terms (in the donor) with the largest weight, ties by term, found by insertion
 * into a k-long list rather than sorting every match; and how many terms matched.
 */
function topMatched(
  ids: Int32Array,
  ws: Float64Array,
  inDonor: Uint8Array,
  termOf: readonly string[],
  k: number,
): { matched: { term: string; w: number }[]; count: number } {
  const top: { term: string; w: number }[] = [];
  let count = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] as number;
    if (inDonor[id] === 0) continue;
    count += 1;
    const x = { term: termOf[id] as string, w: ws[i] as number };
    const before = (a: typeof x, b: typeof x) => a.w > b.w || (a.w === b.w && a.term < b.term);
    if (top.length === k && !before(x, top[k - 1] as typeof x)) continue;
    let j = Math.min(top.length, k - 1);
    top[j] = x;
    while (j > 0 && before(x, top[j - 1] as typeof x)) {
      top[j] = top[j - 1] as typeof x;
      top[j - 1] = x;
      j -= 1;
    }
  }
  return { matched: top, count };
}

/** S_B with w_B: the target view's terms and summed field weights, in term order. */
export function targetWeights(doc: TextDocument): Map<string, number> {
  const w = viewWeights(doc, "target");
  // The default sort compares UTF-16 code units, like cmp, without a JS comparator.
  return new Map([...w.keys()].sort().map((t) => [t, w.get(t) as number]));
}

/** Look up a stored pair by node ids (null if REF ≤ ε or absent). */
export function refEntry(m: RefMatrix, source: string, target: string): RefEntry | null {
  const s = m.nodes.indexOf(source);
  const t = m.nodes.indexOf(target);
  return m.entries.find((e) => e.source === s && e.target === t) ?? null;
}

export interface PersistedRefMatrix extends RefMatrix {
  readonly artefact: ArtefactRow;
}

/**
 * Build the run's text representation under `policyId` (in memory, with the run's stored
 * config), compute its REF matrix and append it as a `ref-matrix` artefact.
 */
export async function buildRefRun(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
  variant: RefVariant = "weighted",
): Promise<PersistedRefMatrix> {
  const { model, config } = await loadTextModel(db, runId, policyId);
  const matrix = refMatrix(model, variant, config);
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion: matrix.policyVersion,
    kind: REF_ARTEFACT,
    payload: matrix as unknown as Json,
  });
  return { ...matrix, artefact };
}
