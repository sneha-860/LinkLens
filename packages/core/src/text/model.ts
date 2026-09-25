import type { LinkLensConfig } from "../config.js";
import { STOP_WORDS, terms, type TokeniseOptions } from "./tokenise.js";

/** Bump whenever the output can change (tokeniser, stop-words, stemmer, weighting, drop rule). */
export const TEXT_VERSION = "text@1.0.0";

export const FIELDS = ["title", "links", "body"] as const;
export type Field = (typeof FIELDS)[number];

/** S_A = Links(A) ∪ Body(A): what page A talks about and points at (donor view). */
export const DONOR_FIELDS: readonly Field[] = ["links", "body"];
/** S_B = Title(B) ∪ Body(B): what page B is about. B's own outgoing anchors are excluded. */
export const TARGET_FIELDS: readonly Field[] = ["title", "body"];
export type View = "donor" | "target";
export const VIEW_FIELDS: Readonly<Record<View, readonly Field[]>> = {
  donor: DONOR_FIELDS,
  target: TARGET_FIELDS,
};

/** One document (a node's representative page) before tokenisation. */
export interface RawDocument {
  readonly node: string;
  readonly fetchId: number;
  readonly url: string;
  /**
   * Field texts. Each string is tokenised on its own, so n-grams never span two of them
   * (title and h1; two anchors).
   */
  readonly title: readonly string[];
  readonly links: readonly string[];
  readonly body: readonly string[];
}

/** term → TF-IDF weight. */
export type Weights = Record<string, number>;

export interface TextDocument {
  readonly node: string;
  readonly fetchId: number;
  readonly url: string;
  /** Per-field TF-IDF weights (tf = raw count in the field), boilerplate removed. */
  readonly fields: Readonly<Record<Field, Weights>>;
  /** S_A: sorted terms of Links ∪ Body. */
  readonly donor: string[];
  /** S_B: sorted terms of Title ∪ Body. */
  readonly target: string[];
}

export interface DroppedTerm {
  readonly term: string;
  /** Documents containing the term (any field). */
  readonly df: number;
}

export interface TextModel {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly params: {
    readonly frequentNgramDropPct: number;
    readonly frequentNgramMinDf: number;
    readonly minTokenLength: number;
    readonly maxNgram: number;
    readonly stopWords: number;
    readonly stemmer: string;
    readonly idf: string;
  };
  readonly stats: {
    readonly documents: number;
    /** Distinct n-grams before boilerplate removal. */
    readonly vocabulary: number;
    readonly dropped: number;
    readonly kept: number;
    /** Lowest document frequency among dropped terms (null if none were dropped). */
    readonly dfCutoff: number | null;
  };
  /** Boilerplate removed, most frequent first. */
  readonly dropped: DroppedTerm[];
  /** IDF of every kept term: ln((1 + N) / (1 + df)) + 1. */
  readonly idf: Weights;
  /** Sorted by node. */
  readonly documents: TextDocument[];
}

export interface TextModelInput {
  readonly runId: number;
  readonly policyVersion: string;
  readonly documents: readonly RawDocument[];
}

type Counts = Map<string, number>;

function count(texts: readonly string[], opts: TokeniseOptions): Counts {
  const c: Counts = new Map();
  for (const text of texts) for (const t of terms(text, opts)) c.set(t, (c.get(t) ?? 0) + 1);
  return c;
}

const byKey = <V>(m: Map<string, V>): [string, V][] =>
  [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The top `dropPct` of the site's distinct n-grams by document frequency (ties: higher total
 * count first, then term), among n-grams in at least `minDf` documents.
 */
export function frequentTerms(
  df: ReadonlyMap<string, number>,
  cf: ReadonlyMap<string, number>,
  dropPct: number,
  minDf: number,
): DroppedTerm[] {
  const quota = Math.floor(dropPct * df.size);
  return [...df]
    .filter(([, d]) => d >= minDf)
    .sort(
      ([a, da], [b, db]) =>
        db - da || (cf.get(b) ?? 0) - (cf.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
    )
    .slice(0, quota)
    .map(([term, d]) => ({ term, df: d }));
}

/** Smoothed IDF (positive even for a term in every document). */
export const idfOf = (documents: number, df: number) => Math.log((1 + documents) / (1 + df)) + 1;

/**
 * Pure: the patent's field-aware text representation for one site.
 * 1. Tokenise each field (see `terms`): Title, Links, Body.
 * 2. Document frequency over the site (a term counts once per document, whatever the field).
 * 3. Drop the top frequentNgramDropPct n-grams by DF (site-specific boilerplate).
 * 4. TF-IDF per field, and the donor (S_A) and target (S_B) term sets.
 */
export function buildTextModel(
  input: TextModelInput,
  config: Pick<
    LinkLensConfig,
    "frequentNgramDropPct" | "frequentNgramMinDf" | "textMinTokenLength" | "textMaxNgram"
  >,
): TextModel {
  const opts: TokeniseOptions = {
    minTokenLength: config.textMinTokenLength,
    maxNgram: config.textMaxNgram,
  };
  const seen = new Set<string>();
  const docs = [...input.documents]
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0))
    .map((d) => {
      if (seen.has(d.node)) throw new Error(`duplicate document for node ${d.node}`);
      seen.add(d.node);
      return {
        raw: d,
        counts: {
          title: count(d.title, opts),
          links: count(d.links, opts),
          body: count(d.body, opts),
        } satisfies Record<Field, Counts>,
      };
    });

  const df = new Map<string, number>();
  const cf = new Map<string, number>();
  for (const { counts } of docs) {
    const inDoc = new Set<string>();
    for (const f of FIELDS) {
      for (const [t, c] of counts[f]) {
        inDoc.add(t);
        cf.set(t, (cf.get(t) ?? 0) + c);
      }
    }
    for (const t of inDoc) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const dropped = frequentTerms(df, cf, config.frequentNgramDropPct, config.frequentNgramMinDf);
  const drop = new Set(dropped.map((d) => d.term));
  const n = docs.length;
  const idf = new Map<string, number>();
  // df's order is already deterministic (documents sorted by node, terms in text order).
  for (const [t, d] of df) if (!drop.has(t)) idf.set(t, idfOf(n, d));

  const documents = docs.map(({ raw, counts }): TextDocument => {
    const fields = {} as Record<Field, Weights>;
    for (const f of FIELDS) {
      const w: Weights = {};
      for (const [t, c] of byKey(counts[f])) {
        const i = idf.get(t);
        if (i !== undefined) w[t] = c * i;
      }
      fields[f] = w;
    }
    const union = (fs: readonly Field[]) =>
      [...new Set(fs.flatMap((f) => Object.keys(fields[f])))].sort();
    return {
      node: raw.node,
      fetchId: raw.fetchId,
      url: raw.url,
      fields,
      donor: union(DONOR_FIELDS),
      target: union(TARGET_FIELDS),
    };
  });

  return {
    version: TEXT_VERSION,
    runId: input.runId,
    policyVersion: input.policyVersion,
    params: {
      frequentNgramDropPct: config.frequentNgramDropPct,
      frequentNgramMinDf: config.frequentNgramMinDf,
      minTokenLength: config.textMinTokenLength,
      maxNgram: config.textMaxNgram,
      stopWords: STOP_WORDS.size,
      stemmer: "porter",
      idf: "ln((1 + N) / (1 + df)) + 1",
    },
    stats: {
      documents: n,
      vocabulary: df.size,
      dropped: dropped.length,
      kept: idf.size,
      dfCutoff: dropped.at(-1)?.df ?? null,
    },
    dropped,
    idf: Object.fromEntries(idf),
    documents,
  };
}

/**
 * A view's term weights: the sum of its fields' TF-IDF weights (a term in both Links and Body
 * counts from both).
 */
export function viewWeights(doc: TextDocument, view: View): Map<string, number> {
  const w = new Map<string, number>();
  for (const f of VIEW_FIELDS[view]) {
    for (const [t, x] of Object.entries(doc.fields[f])) w.set(t, (w.get(t) ?? 0) + x);
  }
  return w;
}
