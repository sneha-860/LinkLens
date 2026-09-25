import type { LinkLensConfig } from "../config.js";
import type { PolicyId } from "../canonicalise/index.js";
import { insertArtefact } from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import { viewWeights, type TextDocument, type TextModel } from "../text/model.js";
import { loadTextModel } from "../text/run.js";

/** Bump whenever the output can change (formula, cutoff, normalisation, explanation). */
export const REF_VERSION = "ref@1.1.0";
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
  /** Document nodes, sorted; entries refer to them by index. */
  readonly nodes: string[];
  readonly stats: {
    readonly nodes: number;
    /** Ordered pairs u ≠ v. */
    readonly pairs: number;
    /** Pairs with REF > 0 before the ε cutoff. */
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
 * Pure: REF(u,v) for every ordered pair of the model's documents, u ≠ v, with S_A = donor(u)
 * and S_B = target(v). Scores ≤ ε become 0 and are not stored; the rest are normalised per
 * source (ρ) and explained by their matched n-grams.
 *
 * Exact all-pairs, but through an inverted index of target terms, so a donor only touches the
 * targets it shares a term with: O(Σ_u Σ_{t ∈ S_A(u)} |postings(t)|) rather than O(n² · |S|).
 */
export function refMatrix(
  model: TextModel,
  variant: RefVariant,
  config: Pick<LinkLensConfig, "epsilon" | "refExplainTerms">,
): RefMatrix {
  const docs = [...model.documents].sort((a, b) => cmp(a.node, b.node));
  const n = docs.length;
  const k = config.refExplainTerms;
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

  const entries: RefEntry[] = [];
  let nonZero = 0;
  let sourcesWithEntries = 0;
  let maxRef: number | null = null;
  const acc = new Float64Array(n);
  const seen = new Uint8Array(n);
  const inDonor = new Uint8Array(m);
  for (let u = 0; u < n; u++) {
    // S_A(u) as term ids, in term order; terms in no target cannot match and are skipped.
    const donor: number[] = [];
    for (const t of (docs[u] as TextDocument).donor) {
      const id = termId.get(t);
      if (id !== undefined) donor.push(id);
    }
    const touched: number[] = [];
    for (const t of donor) {
      for (let p = off[t] as number, end = off[t + 1] as number; p < end; p++) {
        const v = postV[p] as number;
        if (seen[v] === 0) {
          seen[v] = 1;
          touched.push(v);
        }
        acc[v] = (acc[v] as number) + (postW[p] as number);
      }
    }
    touched.sort((a, b) => a - b);
    const row: { v: number; ref: number }[] = [];
    for (const v of touched) {
      const r = (acc[v] as number) / (total[v] as number);
      acc[v] = 0;
      seen[v] = 0;
      if (v === u) continue;
      nonZero += 1;
      if (r > config.epsilon) row.push({ v, ref: r });
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
    textVersion: model.version,
    runId: model.runId,
    policyVersion: model.policyVersion,
    variant,
    epsilon: config.epsilon,
    explainTerms: config.refExplainTerms,
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
