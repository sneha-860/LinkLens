import type { LinkLensConfig } from "../config.js";
import { matchedTerms } from "./rescue.js";
import { ref, type RefVariant } from "../semantic/ref.js";
import { spannedPhrases, type SpannedWord, type TokeniseOptions } from "../text/tokenise.js";

/**
 * The patent's element-level REF, for anchor text: where on the donor page the link should go
 * and what it should say.
 *
 * For a fix u → v, each paragraph p of u (the extractor's `<p>` and `<li>` of the main content)
 * is scored against the target's Title field (`<title>` and `<h1>`, boilerplate removed):
 *
 *   REF(p, Title(v)) = Σ_{t ∈ S_p ∩ T_v} w_T(t) / Σ_{t ∈ T_v} w_T(t)
 *
 * with w_T the target's Title TF-IDF weights (weighted variant), or |S_p ∩ T_v| / |T_v|
 * (unweighted), S_p being the paragraph's n-grams under the site's tokeniser. The best paragraph
 * (highest REF, ties to the earlier one) is used when its REF is above ε, and the suggested anchor
 * is the matched n-gram with the largest Title weight (ties: more words, then the earlier
 * occurrence, then the term), quoted exactly as the paragraph writes it.
 *
 * Text the donor already links (its content-region anchor texts, found verbatim in the
 * paragraph) cannot take another link: it is left out of S_p and breaks n-grams, so a paragraph
 * that is only a link (a list of links) scores 0.
 */

/** A matched n-gram of the chosen paragraph, as the paragraph writes it. */
export interface ParagraphTerm {
  readonly term: string;
  /** Its share of the paragraph's REF (w_T(t) / Σ w_T, or 1 / |T_v| unweighted). */
  readonly contribution: number;
  /** The words as written at its first occurrence in the paragraph. */
  readonly words: string;
}

export interface AnchorSuggestion {
  readonly status: "suggested";
  /** Index of the chosen paragraph among the donor's paragraphs (0-based). */
  readonly paragraphIndex: number;
  readonly paragraphs: number;
  /** REF(p, Title(v)) of the chosen paragraph (> ε). */
  readonly ref: number;
  /** The anchor's stemmed n-gram, its Title weight w_T and its share of Σ w_T. */
  readonly term: string;
  readonly weight: number;
  readonly share: number;
  /** The anchor as written in the paragraph. */
  readonly anchor: string;
  /**
   * The paragraph around the anchor (at most anchorExcerptChars, cut at word boundaries, plus
   * an ellipsis where cut); the anchor is excerpt.text.slice(anchorStart, anchorEnd).
   */
  readonly excerpt: {
    readonly text: string;
    readonly anchorStart: number;
    readonly anchorEnd: number;
  };
  /** The paragraph's matched n-grams, largest share first (at most explainTerms). */
  readonly matched: ParagraphTerm[];
}

export interface NoAnchor {
  readonly status: "none";
  /**
   * no-paragraphs: the donor has no stored paragraph; no-title-terms: the target's title has no
   * term left after boilerplate removal; not-above-epsilon: no paragraph's REF exceeds ε.
   */
  readonly reason: "no-paragraphs" | "no-title-terms" | "not-above-epsilon";
  readonly paragraphs: number;
  /** The best paragraph's REF and index (null without paragraphs or title terms). */
  readonly bestRef: number | null;
  readonly bestParagraphIndex: number | null;
}

export type AnchorResult = AnchorSuggestion | NoAnchor;

export interface AnchorInput {
  /** The donor's paragraphs, in document order. */
  readonly paragraphs: readonly string[];
  /** The target's Title field weights (term → TF-IDF), boilerplate removed. */
  readonly title: ReadonlyMap<string, number>;
  readonly variant: RefVariant;
  /** Anchor texts of the donor's existing content links (text already linked; see above). */
  readonly linked?: readonly string[];
}

export type AnchorConfig = Pick<LinkLensConfig, "epsilon" | "explainTerms" | "anchorExcerptChars"> &
  TokeniseOptions;

interface Occurrence {
  readonly start: number;
  readonly end: number;
  /** Order of first occurrence in the paragraph (word index of its first word). */
  readonly order: number;
}

/** Every [start, end) where one of `linked` occurs verbatim in `text` (empty strings ignored). */
export function linkedRanges(text: string, linked: readonly string[]): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of new Set(linked.map((l) => l.trim()))) {
    if (raw === "") continue;
    for (let i = text.indexOf(raw); i !== -1; i = text.indexOf(raw, i + raw.length)) {
      out.push([i, i + raw.length]);
    }
  }
  return out;
}

/**
 * A paragraph's n-grams with the span of each one's first occurrence. Words overlapping a
 * `blocked` range (already linked) are dropped and split the phrase.
 */
export function paragraphNgrams(
  text: string,
  opts: TokeniseOptions,
  blocked: readonly (readonly [number, number])[] = [],
): Map<string, Occurrence> {
  const out = new Map<string, Occurrence>();
  const free = (w: SpannedWord) => blocked.every(([a, b]) => w.end <= a || w.start >= b);
  const phrases: SpannedWord[][] = [];
  for (const phrase of spannedPhrases(text, opts) ?? []) {
    let run: SpannedWord[] = [];
    for (const w of phrase) {
      if (free(w)) run.push(w);
      else if (run.length > 0) {
        phrases.push(run);
        run = [];
      }
    }
    if (run.length > 0) phrases.push(run);
  }
  let order = 0;
  for (const words of phrases) {
    for (let i = 0; i < words.length; i++, order++) {
      for (let n = 1; n <= opts.maxNgram && i + n <= words.length; n++) {
        const slice = words.slice(i, i + n);
        const term = slice.map((w) => w.stem).join(" ");
        if (!out.has(term)) {
          out.set(term, {
            start: (slice[0] as SpannedWord).start,
            end: (slice[n - 1] as SpannedWord).end,
            order,
          });
        }
      }
    }
  }
  return out;
}

/**
 * At most `max` characters of `text` around [start, end), cut at word boundaries (never inside
 * the anchor), with "…" where cut; returns the excerpt and the anchor's offsets in it.
 */
export function excerpt(
  text: string,
  start: number,
  end: number,
  max: number,
): AnchorSuggestion["excerpt"] {
  if (text.length <= max) return { text, anchorStart: start, anchorEnd: end };
  const space = (i: number) => /\s/u.test(text[i] ?? "");
  // A window of `max` characters with the anchor in the middle, moved inside the text.
  let a = Math.max(0, start - Math.floor(Math.max(0, max - (end - start)) / 2));
  let b = Math.min(text.length, Math.max(a + max, end));
  a = Math.max(0, Math.min(a, b - max));
  // Never cut a word: start after the first space, end at the last one (outside the anchor).
  if (a > 0 && !space(a - 1)) {
    const i = text.slice(a, start).search(/\s/u);
    a = i === -1 ? start : a + i + 1;
  }
  if (b < text.length && !space(b)) {
    const i = text.slice(end, b).search(/\s\S*$/u);
    b = i === -1 ? end : end + i;
  }
  while (a < start && space(a)) a++;
  while (b > end && space(b - 1)) b--;
  const head = a > 0 ? "…" : "";
  return {
    text: `${head}${text.slice(a, b)}${b < text.length ? "…" : ""}`,
    anchorStart: head.length + start - a,
    anchorEnd: head.length + end - a,
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the best donor paragraph for the target's title and the anchor to use in it. */
export function suggestAnchor(input: AnchorInput, config: AnchorConfig): AnchorResult {
  const paragraphs = input.paragraphs.length;
  const opts = { minTokenLength: config.minTokenLength, maxNgram: config.maxNgram };
  if (paragraphs === 0) {
    return {
      status: "none",
      reason: "no-paragraphs",
      paragraphs,
      bestRef: null,
      bestParagraphIndex: null,
    };
  }
  const total = [...input.title.values()].reduce((s, w) => s + w, 0);
  if (input.title.size === 0 || total <= 0) {
    return {
      status: "none",
      reason: "no-title-terms",
      paragraphs,
      bestRef: null,
      bestParagraphIndex: null,
    };
  }

  // The best paragraph; a tie keeps the earlier one.
  let chosen = { index: -1, ref: -1, grams: new Map<string, Occurrence>() };
  for (let index = 0; index < paragraphs; index++) {
    const text = input.paragraphs[index] as string;
    const grams = paragraphNgrams(text, opts, linkedRanges(text, input.linked ?? []));
    const r = ref(new Set(grams.keys()), input.title, input.variant);
    if (r > chosen.ref) chosen = { index, ref: r, grams };
  }
  if (!(chosen.ref > config.epsilon)) {
    return {
      status: "none",
      reason: "not-above-epsilon",
      paragraphs,
      bestRef: chosen.ref,
      bestParagraphIndex: chosen.index,
    };
  }

  const text = input.paragraphs[chosen.index] as string;
  const words = (t: string) => {
    const o = chosen.grams.get(t) as Occurrence;
    return text.slice(o.start, o.end);
  };
  const [term] = [...input.title]
    .filter(([t]) => chosen.grams.has(t))
    .sort(
      ([a, wa], [b, wb]) =>
        wb - wa ||
        b.split(" ").length - a.split(" ").length ||
        (chosen.grams.get(a) as Occurrence).order - (chosen.grams.get(b) as Occurrence).order ||
        cmp(a, b),
    )[0] as [string, number];
  const weight = input.title.get(term) as number;
  const at = chosen.grams.get(term) as Occurrence;

  return {
    status: "suggested",
    paragraphIndex: chosen.index,
    paragraphs,
    ref: chosen.ref,
    term,
    weight,
    share: weight / total,
    anchor: words(term),
    excerpt: excerpt(text, at.start, at.end, config.anchorExcerptChars),
    matched: matchedTerms(
      new Set(chosen.grams.keys()),
      input.title,
      input.variant,
      config.explainTerms,
    ).map((m) => ({ term: m.term, contribution: m.contribution, words: words(m.term) })),
  };
}
