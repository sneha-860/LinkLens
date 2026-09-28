import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import {
  excerpt,
  linkedRanges,
  paragraphNgrams,
  suggestAnchor,
  type AnchorConfig,
} from "./anchor.js";

const config: AnchorConfig = {
  ...makeConfig({ epsilon: 0.2, explainTerms: 3, anchorExcerptChars: 60 }),
  minTokenLength: 2,
  maxNgram: 2,
};
const title = (w: Record<string, number>) => new Map(Object.entries(w));
// "Loggerhead turtle nesting": the bigram is the rarest, so it weighs most.
const turtle = title({
  loggerhead: 2,
  turtl: 1,
  nest: 1,
  "turtl nest": 3,
  "loggerhead turtl": 2.5,
});

describe("paragraphNgrams", () => {
  it("keeps each n-gram's first span in the original text", () => {
    const text = "Volunteers watch Turtle Nesting; turtle nesting again.";
    const grams = paragraphNgrams(text, config);
    const span = grams.get("turtl nest");
    expect(span).toBeDefined();
    expect(text.slice(span?.start, span?.end)).toBe("Turtle Nesting");
    // A bigram never crosses punctuation.
    expect(grams.has("nest turtl")).toBe(false);
  });

  it("spans a dropped stop-word inside a bigram", () => {
    const text = "Read the Terms of Service first.";
    const span = paragraphNgrams(text, config).get("term servic");
    expect(text.slice(span?.start, span?.end)).toBe("Terms of Service");
  });
});

describe("suggestAnchor", () => {
  it("picks the paragraph with the highest REF to the title and its heaviest matched n-gram", () => {
    const a = suggestAnchor(
      {
        paragraphs: [
          "Our turtle guide is short.", // turtl: 1 / 9.5
          "Every summer, volunteers guard the beaches where Turtle Nesting happens.", // 5 / 9.5
          "Nesting boxes for birds.", // nest: 1 / 9.5
        ],
        title: turtle,
        variant: "weighted",
      },
      config,
    );
    expect(a).toMatchObject({
      status: "suggested",
      paragraphIndex: 1,
      paragraphs: 3,
      term: "turtl nest",
      weight: 3,
      anchor: "Turtle Nesting",
    });
    if (a.status !== "suggested") throw new Error("expected a suggestion");
    expect(a.ref).toBeCloseTo(5 / 9.5, 12);
    expect(a.share).toBeCloseTo(3 / 9.5, 12);
    expect(a.matched.map((m) => [m.term, m.words])).toEqual([
      ["turtl nest", "Turtle Nesting"],
      ["nest", "Nesting"],
      ["turtl", "Turtle"],
    ]);
    expect(a.excerpt.text.slice(a.excerpt.anchorStart, a.excerpt.anchorEnd)).toBe("Turtle Nesting");
  });

  it("breaks ties: the earlier paragraph; then the longer n-gram, the earlier one, the term", () => {
    const even = title({ whale: 1, song: 1, "whale song": 1 });
    const a = suggestAnchor(
      {
        paragraphs: ["Whale song recordings.", "Whale song archive."],
        title: even,
        variant: "weighted",
      },
      config,
    );
    expect(a).toMatchObject({ paragraphIndex: 0, term: "whale song", anchor: "Whale song" });
    const b = suggestAnchor(
      {
        paragraphs: ["Songs of the sea, and whales too."],
        title: title({ whale: 1, song: 1 }),
        variant: "weighted",
      },
      { ...config, epsilon: 0.1 },
    );
    expect(b).toMatchObject({ term: "song", anchor: "Songs" });
  });

  it("uses |S_p ∩ T| / |T| for the unweighted variant (the anchor is still the heaviest term)", () => {
    const a = suggestAnchor(
      { paragraphs: ["A loggerhead on the beach."], title: turtle, variant: "unweighted" },
      { ...config, epsilon: 0.1 },
    );
    expect(a).toMatchObject({ status: "suggested", ref: 1 / 5, term: "loggerhead" });
  });

  it("says why there is no suggestion", () => {
    expect(suggestAnchor({ paragraphs: [], title: turtle, variant: "weighted" }, config)).toEqual({
      status: "none",
      reason: "no-paragraphs",
      paragraphs: 0,
      bestRef: null,
      bestParagraphIndex: null,
    });
    expect(
      suggestAnchor({ paragraphs: ["Turtles."], title: new Map(), variant: "weighted" }, config),
    ).toMatchObject({ status: "none", reason: "no-title-terms" });
    // REF 1 / 9.5 is not above ε 0.2.
    expect(
      suggestAnchor(
        { paragraphs: ["Cake recipes.", "A turtle."], title: turtle, variant: "weighted" },
        config,
      ),
    ).toEqual({
      status: "none",
      reason: "not-above-epsilon",
      paragraphs: 2,
      bestRef: 1 / 9.5,
      bestParagraphIndex: 1,
    });
  });

  it("is deterministic", () => {
    const input = {
      paragraphs: ["Turtle nesting season.", "Loggerhead turtle nesting on the beach."],
      title: turtle,
      variant: "weighted" as const,
    };
    expect(JSON.stringify(suggestAnchor(input, config))).toBe(
      JSON.stringify(suggestAnchor(input, config)),
    );
  });
});

describe("excerpt", () => {
  const long =
    "At dawn the rangers walk the whole beach, counting tracks, and every summer they guard the " +
    "places where Turtle Nesting happens until the hatchlings reach the sea at night.";
  const at = long.indexOf("Turtle Nesting");

  it("returns a short paragraph whole", () => {
    expect(excerpt("Turtle Nesting here.", 0, 14, 60)).toEqual({
      text: "Turtle Nesting here.",
      anchorStart: 0,
      anchorEnd: 14,
    });
  });

  it("cuts a long one around the anchor at word boundaries, with ellipses", () => {
    const e = excerpt(long, at, at + 14, 60);
    expect(e.text.startsWith("…")).toBe(true);
    expect(e.text.endsWith("…")).toBe(true);
    expect(e.text.length).toBeLessThanOrEqual(62);
    expect(e.text.slice(e.anchorStart, e.anchorEnd)).toBe("Turtle Nesting");
    // Whole words only.
    const inner = e.text.slice(1, -1);
    expect(long.includes(inner)).toBe(true);
    expect(long[long.indexOf(inner) - 1]).toBe(" ");
    expect(long[long.indexOf(inner) + inner.length]).toBe(" ");
  });

  it("keeps the start or the end when the anchor is near it", () => {
    const e = excerpt(long, 0, 7, 40);
    expect(e.text.startsWith("At dawn")).toBe(true);
    expect(e.anchorStart).toBe(0);
    const end = long.length - "sea at night.".length;
    const f = excerpt(long, end, long.length, 40);
    expect(f.text.endsWith("sea at night.")).toBe(true);
    expect(f.text.slice(f.anchorStart, f.anchorEnd)).toBe("sea at night.");
  });

  it("never cuts the anchor, even when it is longer than the limit", () => {
    const e = excerpt(long, at, at + 30, 10);
    expect(e.text.slice(e.anchorStart, e.anchorEnd)).toBe(long.slice(at, at + 30));
  });
});

describe("text that is already linked", () => {
  it("is left out of the paragraph's n-grams and breaks bigrams", () => {
    const text = "See Turtle Nesting and Whale Songs today.";
    expect(linkedRanges(text, ["Whale Songs", " ", "absent"])).toEqual([[23, 34]]);
    const grams = paragraphNgrams(text, config, linkedRanges(text, ["Nesting"]));
    expect(grams.has("turtl")).toBe(true);
    expect(grams.has("nest")).toBe(false);
    expect(grams.has("turtl nest")).toBe(false);
    // No bigram across the gap the link leaves.
    expect(grams.has("turtl whale")).toBe(false);
  });

  it("never becomes the anchor: a paragraph that is only a link scores 0", () => {
    const input = {
      paragraphs: ["Loggerhead turtle nesting guide", "Volunteers record turtle nesting."],
      title: turtle,
      variant: "weighted" as const,
    };
    // Unlinked, the first paragraph covers the whole title (REF 1) and wins.
    expect(suggestAnchor(input, config)).toMatchObject({ paragraphIndex: 0, ref: 1 });
    // Linked (a list item that is a link), it scores 0 and the second paragraph is used.
    const linked = suggestAnchor({ ...input, linked: ["Loggerhead turtle nesting guide"] }, config);
    expect(linked).toMatchObject({
      status: "suggested",
      paragraphIndex: 1,
      ref: 5 / 9.5,
      anchor: "turtle nesting",
    });
    // Everything linked: no paragraph left for a new link.
    expect(suggestAnchor({ ...input, linked: [...input.paragraphs] }, config)).toMatchObject({
      status: "none",
      reason: "not-above-epsilon",
      bestRef: 0,
    });
  });
});
