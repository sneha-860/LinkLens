import { describe, expect, it } from "vitest";
import { ngrams, phrases, spannedPhrases, STOP_WORDS, terms, wordPhrases } from "./tokenise.js";

const opts = { minTokenLength: 2, maxNgram: 2 };

describe("phrases", () => {
  it("lower-cases, drops stop-words and numbers, and Porter-stems", () => {
    expect(phrases("The Running Dogs of 2024", opts)).toEqual([["run", "dog"]]);
  });

  it("splits phrases at punctuation, not at dropped stop-words", () => {
    expect(phrases("Terms of Service, Privacy Policy | Acme", opts)).toEqual([
      ["term", "servic"],
      ["privaci", "polici"],
      ["acm"],
    ]);
  });

  it("treats hyphens as word breaks inside a phrase", () => {
    expect(phrases("state-of-the-art whales", opts)).toEqual([["state", "art", "whale"]]);
  });

  it("removes apostrophes inside words and keeps non-ASCII letters", () => {
    expect(phrases("Company's café crème", opts)).toEqual([["compani", "café", "crème"]]);
  });

  it("drops purely numeric tokens (any script) but keeps alphanumerics", () => {
    expect(phrases("3.5 1,000 ٣ mp3 v2", opts)).toEqual([["mp3", "v2"]]);
  });

  it("drops tokens shorter than minTokenLength", () => {
    expect(phrases("x yz", opts)).toEqual([["yz"]]);
    expect(phrases("x yz", { ...opts, minTokenLength: 3 })).toEqual([]);
  });

  it("NFKC-normalises (full-width letters)", () => {
    expect(phrases("ＷＨＡＬＥＳ", opts)).toEqual([["whale"]]);
  });

  it("has an English stop-word list including contraction-free forms", () => {
    for (const w of ["the", "and", "of", "is", "you"]) expect(STOP_WORDS.has(w)).toBe(true);
  });
});

describe("ngrams / terms", () => {
  it("generates unigrams then bigrams, in order", () => {
    expect(ngrams(["a", "b", "c"], 2)).toEqual(["a", "b", "c", "a b", "b c"]);
    expect(ngrams(["a", "b", "c"], 1)).toEqual(["a", "b", "c"]);
    expect(ngrams(["a", "b", "c"], 3)).toEqual(["a", "b", "c", "a b", "b c", "a b c"]);
  });

  it("never forms a bigram across punctuation", () => {
    expect(terms("Blue whales. Ocean currents", opts)).toEqual([
      "blue",
      "whale",
      "blue whale",
      "ocean",
      "current",
      "ocean current",
    ]);
  });

  it("never forms a bigram across a line break (the blocks of body_text)", () => {
    expect(terms("About the author\nBack to blog", opts)).toEqual([
      "author",
      "back",
      "blog",
      "back blog",
    ]);
    expect(terms("blue\twhale  songs", opts)).toContain("blue whale");
  });

  it("keeps repeats (term frequency)", () => {
    expect(terms("whale whale", opts)).toEqual(["whale", "whale", "whale whale"]);
  });

  it("is empty for text with no content words", () => {
    expect(terms("The and of 42 — !!", opts)).toEqual([]);
  });
});

describe("spannedPhrases", () => {
  const samples = [
    "The Running Dogs of 2024",
    "Terms of Service, Privacy Policy | Acme",
    "state-of-the-art whales",
    "Company's café crème; don’t STOP",
    "3.5 1,000 ٣ mp3 v2",
    "ﬁne ＦＵＬＬＷＩＤＴＨ text， and ligatures",
    "Café au lait and éclair",
    "İstanbul ΟΔΟΣ ΚΑΛΟΣ",
    "emoji 🐢 turtles 🐢's nests",
    "line one\nline two\ttabbed",
    "'quoted' words' ends 'n' rock",
    "",
  ];

  it("gives the same words, stems and phrases as wordPhrases", () => {
    for (const s of samples) {
      const spanned = spannedPhrases(s, opts);
      expect(spanned, s).not.toBeNull();
      expect(
        spanned?.map((p) => p.map((w) => ({ stem: w.stem, surface: w.surface }))),
        s,
      ).toEqual(wordPhrases(s, opts));
    }
  });

  it("points each word at its original text", () => {
    const s = "Read the Terms of Service, don’t skip Café́ notes";
    const words = (spannedPhrases(s, opts) ?? []).flat();
    expect(words.map((w) => s.slice(w.start, w.end))).toEqual([
      "Read",
      "Terms",
      "Service",
      "don’t",
      "skip",
      "Café́",
      "notes",
    ]);
  });
});
