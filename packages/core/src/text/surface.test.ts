import { describe, expect, it } from "vitest";
import type { RawDocument } from "./model.js";
import { SurfaceForms } from "./surface.js";
import { phrases, terms as termsOf, wordPhrases } from "./tokenise.js";

const opts = { minTokenLength: 2, maxNgram: 2 };
const doc = (node: string, title: string[], body: string[], links: string[] = []): RawDocument => ({
  node,
  fetchId: 1,
  url: node,
  title,
  links,
  body,
});

describe("wordPhrases", () => {
  it("keeps each word as written next to its stem, with the same phrases as `phrases`", () => {
    const text = "Running Shoes, for the trail. Run!";
    expect(wordPhrases(text, opts)).toEqual([
      [
        { stem: "run", surface: "running" },
        { stem: "shoe", surface: "shoes" },
      ],
      [{ stem: "trail", surface: "trail" }],
      [{ stem: "run", surface: "run" }],
    ]);
    expect(phrases(text, opts)).toEqual([["run", "shoe"], ["trail"], ["run"]]);
  });
});

describe("SurfaceForms", () => {
  const docs = [
    doc("https://s.test/a", ["Running shoes"], ["Our running shoes. Running shoes for trails."]),
    doc("https://s.test/b", ["Run shoe guide"], ["How to run in a shoe."], ["running shoes"]),
    doc("https://s.test/c", ["Trails"], ["Trail running."]),
  ];
  const wanted = new Set(["run shoe", "trail", "run", "absent"]);
  const forms = new SurfaceForms(docs, wanted, opts);

  it("returns the most frequent form in the first node that uses the term", () => {
    expect(forms.of("run shoe", ["https://s.test/a"])).toBe("running shoes");
    expect(forms.of("run shoe", ["https://s.test/b"])).toBe("run shoe"); // 2 × "run shoe", 1 × "running shoes"
    expect(forms.of("trail", ["https://s.test/c", "https://s.test/a"])).toBe("trail"); // 1 each: shorter wins
    expect(forms.of("trail", ["https://s.test/a"])).toBe("trails");
  });

  it("falls back to the next node, then the site, then the stem", () => {
    expect(forms.of("run shoe", ["https://s.test/c", "https://s.test/a"])).toBe("running shoes");
    expect(forms.of("run shoe", ["https://s.test/zzz"])).toBe("running shoes"); // site: 5 vs 2
    expect(forms.of("run shoe")).toBe("running shoes");
    expect(forms.of("absent", ["https://s.test/a"])).toBe("absent");
    expect(forms.of("not asked for")).toBe("not asked for");
  });

  it("counts only the terms asked for, and every one of them", () => {
    const counted = new Set<string>();
    for (const d of docs)
      for (const t of [...d.title, ...d.links, ...d.body].flatMap((x) => termsOf(x, opts)))
        if (wanted.has(t)) counted.add(t);
    expect([...counted].sort()).toEqual(["run", "run shoe", "trail"]);
    expect(new SurfaceForms(docs, new Set(), opts).of("run shoe")).toBe("run shoe");
  });
});
