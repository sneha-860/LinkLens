import { stemmer } from "stemmer";
import { eng } from "stopword";

export interface TokeniseOptions {
  /** Tokens shorter than this (before stemming) are discarded. */
  readonly minTokenLength: number;
  /** Longest n-gram generated (2 = unigrams + bigrams). */
  readonly maxNgram: number;
}

/**
 * English stop-words (the `stopword` package's list), plus each one without apostrophes, since
 * tokens have their apostrophes removed ("don't" → "dont").
 */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  eng.flatMap((w) => [w.toLowerCase(), w.toLowerCase().replace(/['’]/g, "")]),
);

/**
 * Characters that end a phrase: n-grams never span them. Anything that is not a letter, digit,
 * horizontal whitespace, hyphen or apostrophe ("Home | Acme", "apples, pears", "end. Start"),
 * including line breaks, which separate the blocks of body_text.
 */
const PHRASE_BREAK = /[^\p{L}\p{M}\p{N}\p{Zs}\t'’-]+/u;
/** Word separators inside a phrase. */
const WORD_BREAK = /[^\p{L}\p{M}\p{N}]+/u;
const NUMERIC = /^\p{N}+$/u;

/** A content word: its Porter stem, and the word as it appeared (normalised, lower-case). */
export interface Word {
  readonly stem: string;
  readonly surface: string;
}

/**
 * The content words of `text` as phrases (runs of words not interrupted by punctuation). NFKC,
 * lower-case, apostrophes inside words removed, then per word: numbers, stop-words and words
 * shorter than `minTokenLength` are dropped and the rest are Porter-stemmed. A dropped stop-word
 * does not break a phrase ("terms of service" → [term, servic]).
 */
export function wordPhrases(text: string, opts: TokeniseOptions): Word[][] {
  const normalised = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?<=[\p{L}\p{N}])['’](?=[\p{L}\p{N}])/gu, "");
  const out: Word[][] = [];
  for (const phrase of normalised.split(PHRASE_BREAK)) {
    const words: Word[] = [];
    for (const word of phrase.split(WORD_BREAK)) {
      if (word === "" || NUMERIC.test(word) || STOP_WORDS.has(word)) continue;
      if ([...word].length < opts.minTokenLength) continue;
      words.push({ stem: stemmer(word), surface: word });
    }
    if (words.length > 0) out.push(words);
  }
  return out;
}

/** A content word and where it is written in the original text (UTF-16 offsets, end exclusive). */
export interface SpannedWord extends Word {
  readonly start: number;
  readonly end: number;
}

/** One base character with its combining marks (or leading marks): the unit NFKC maps. */
const SEGMENT = /\P{M}\p{M}*|\p{M}+/gu;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
/** The code point starting at `i` is a letter or digit. */
const letterOrDigitAt = (s: string, i: number) => {
  const cp = s.codePointAt(i);
  return cp !== undefined && LETTER_OR_DIGIT.test(String.fromCodePoint(cp));
};
/** The code point ending just before `i` is a letter or digit (surrogate pairs included). */
const letterOrDigitBefore = (s: string, i: number) => {
  if (i === 0) return false;
  const low = s.charCodeAt(i - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && i >= 2 ? i - 2 : i - 1;
  return letterOrDigitAt(s, start);
};
const PHRASE = /[\p{L}\p{M}\p{N}\p{Zs}\t'’-]+/gu;
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * wordPhrases with each word's span in `text`, so a term can be quoted exactly as written
 * ("Terms of Service" for the term "term servic"). The same words, stems and phrases as
 * wordPhrases (tested). Normalisation is applied per base character with its marks, and each
 * normalised character remembers the original span it came from. Returns null in the rare case
 * where that differs from normalising the whole text (e.g. conjoining Hangul jamo).
 */
export function spannedPhrases(text: string, opts: TokeniseOptions): SpannedWord[][] | null {
  let norm = "";
  const from: number[] = [];
  const to: number[] = [];
  for (const m of text.matchAll(SEGMENT)) {
    const n = m[0].normalize("NFKC");
    norm += n;
    for (let i = 0; i < n.length; i++) {
      from.push(m.index);
      to.push(m.index + m[0].length);
    }
  }
  if (norm !== text.normalize("NFKC")) return null;
  // Lower-case the whole string (Greek final sigma depends on context). When that changes the
  // length ("İ" → "i̇"), the offsets follow each code point's own lower-case length.
  const lower = norm.toLowerCase();
  if (lower.length !== norm.length) {
    const f: number[] = [];
    const t: number[] = [];
    for (let i = 0; i < norm.length;) {
      const cp = String.fromCodePoint(norm.codePointAt(i) as number);
      for (let j = 0; j < cp.toLowerCase().length; j++) {
        f.push(from[i] as number);
        t.push(to[i + cp.length - 1] as number);
      }
      i += cp.length;
    }
    if (f.length !== lower.length) return null;
    from.splice(0, from.length, ...f);
    to.splice(0, to.length, ...t);
  }
  // Remove apostrophes inside words, keeping the offsets of what stays.
  let clean = "";
  const cf: number[] = [];
  const ct: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i] as string;
    if (
      (c === "'" || c === "’") &&
      letterOrDigitBefore(lower, i) &&
      letterOrDigitAt(lower, i + 1)
    ) {
      continue;
    }
    clean += c;
    cf.push(from[i] as number);
    ct.push(to[i] as number);
  }

  const out: SpannedWord[][] = [];
  for (const p of clean.matchAll(PHRASE)) {
    const words: SpannedWord[] = [];
    for (const w of p[0].matchAll(WORD)) {
      const word = w[0];
      if (NUMERIC.test(word) || STOP_WORDS.has(word)) continue;
      if ([...word].length < opts.minTokenLength) continue;
      const i = p.index + w.index;
      words.push({
        stem: stemmer(word),
        surface: word,
        start: cf[i] as number,
        end: ct[i + word.length - 1] as number,
      });
    }
    if (words.length > 0) out.push(words);
  }
  return out;
}

/** wordPhrases, stems only. */
export function phrases(text: string, opts: TokeniseOptions): string[][] {
  return wordPhrases(text, opts).map((p) => p.map((w) => w.stem));
}

/** Every n-gram of `words` for n = 1…maxNgram, in order; an n-gram's words are space-joined. */
export function ngrams(words: readonly string[], maxNgram: number): string[] {
  const out: string[] = [];
  for (let n = 1; n <= maxNgram; n++) {
    for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  }
  return out;
}

/** Unigrams + … + maxNgram-grams of `text`, with repeats (term frequencies are counts of these). */
export function terms(text: string, opts: TokeniseOptions): string[] {
  return phrases(text, opts).flatMap((words) => ngrams(words, opts.maxNgram));
}
