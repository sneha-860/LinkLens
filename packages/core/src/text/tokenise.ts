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
 * whitespace, hyphen or apostrophe ("Home | Acme", "apples, pears", "end. Start").
 */
const PHRASE_BREAK = /[^\p{L}\p{M}\p{N}\s'’-]+/u;
/** Word separators inside a phrase. */
const WORD_BREAK = /[^\p{L}\p{M}\p{N}]+/u;
const NUMERIC = /^\p{N}+$/u;

/**
 * The content words of `text`, stemmed, as phrases (runs of words not interrupted by
 * punctuation). NFKC, lower-case, apostrophes inside words removed, then per word: numbers,
 * stop-words and words shorter than `minTokenLength` are dropped and the rest are Porter-stemmed.
 * A dropped stop-word does not break a phrase ("terms of service" → [term, servic]).
 */
export function phrases(text: string, opts: TokeniseOptions): string[][] {
  const normalised = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?<=[\p{L}\p{N}])['’](?=[\p{L}\p{N}])/gu, "");
  const out: string[][] = [];
  for (const phrase of normalised.split(PHRASE_BREAK)) {
    const words: string[] = [];
    for (const word of phrase.split(WORD_BREAK)) {
      if (word === "" || NUMERIC.test(word) || STOP_WORDS.has(word)) continue;
      if ([...word].length < opts.minTokenLength) continue;
      words.push(stemmer(word));
    }
    if (words.length > 0) out.push(words);
  }
  return out;
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
