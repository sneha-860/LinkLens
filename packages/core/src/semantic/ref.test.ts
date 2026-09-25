import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import { buildTextModel, type RawDocument, type TextModel } from "../text/model.js";
import { ref, refEntry, refMatrix, targetWeights, type RefMatrix } from "./ref.js";
import { syntheticSite } from "./synthetic.js";

const S = "https://site.test";
const noDrop = makeConfig({ frequentNgramDropPct: 0 });
const model = (documents: RawDocument[]): TextModel =>
  buildTextModel({ runId: 1, policyVersion: "P0@1.0.0", documents }, noDrop);
const page = (path: string, title: string, body: string, links: string[] = []): RawDocument => ({
  node: S + path,
  fetchId: path.length,
  url: S + path,
  title: [title],
  links,
  body: [body],
});

// A hub covering several animals, and a leaf about one of them.
const hub = page(
  "/animals",
  "Marine animals",
  "Whale facts. Dolphin pods. Shark teeth. Turtle nesting. Seal colonies. Octopus camouflage.",
  ["Whale facts", "Dolphins", "Sharks"],
);
const leaf = page("/whale", "Whale facts", "Whale.");
const other = page("/recipes", "Cake recipes", "Chocolate cake. Lemon tart.");
const site = model([hub, leaf, other]);
const byPair = (m: RefMatrix, a: string, b: string) => refEntry(m, S + a, S + b)?.ref ?? 0;

describe("ref (one pair)", () => {
  const t = new Map([
    ["whale", 3],
    ["fact", 1],
  ]);

  it("weighted: matched target weight over total target weight", () => {
    expect(ref(new Set(["whale"]), t, "weighted")).toBeCloseTo(0.75);
    expect(ref(new Set(["fact"]), t, "weighted")).toBeCloseTo(0.25);
  });

  it("unweighted: |S_A ∩ S_B| / |S_B|", () => {
    expect(ref(new Set(["whale"]), t, "unweighted")).toBe(0.5);
    expect(ref(new Set(["whale", "fact", "extra"]), t, "unweighted")).toBe(1);
  });

  it("is 0 for an empty target or no overlap", () => {
    expect(ref(new Set(["whale"]), new Map(), "weighted")).toBe(0);
    expect(ref(new Set(["cake"]), t, "weighted")).toBe(0);
  });
});

describe("asymmetry", () => {
  for (const variant of ["weighted", "unweighted"] as const) {
    it(`a hub containing a leaf scores high hub→leaf and low leaf→hub (${variant})`, () => {
      const m = refMatrix(site, variant, { epsilon: 0, refExplainTerms: 10 });
      const hubToLeaf = byPair(m, "/animals", "/whale");
      const leafToHub = byPair(m, "/whale", "/animals");
      expect(hubToLeaf).toBe(1);
      expect(leafToHub).toBeGreaterThan(0);
      expect(leafToHub).toBeLessThan(0.3);
      expect(byPair(m, "/animals", "/recipes")).toBe(0);
    });
  }

  it("weighting changes the score (rare terms weigh more than shared ones)", () => {
    const w = refMatrix(site, "weighted", { epsilon: 0, refExplainTerms: 10 });
    const u = refMatrix(site, "unweighted", { epsilon: 0, refExplainTerms: 10 });
    expect(byPair(w, "/whale", "/animals")).not.toBeCloseTo(byPair(u, "/whale", "/animals"), 6);
  });
});

describe("ε cutoff", () => {
  it("drops pairs below ε and keeps the rest", () => {
    const all = refMatrix(site, "weighted", { epsilon: 0, refExplainTerms: 10 });
    const leafToHub = byPair(all, "/whale", "/animals");
    const cut = refMatrix(site, "weighted", { epsilon: leafToHub + 1e-9, refExplainTerms: 10 });
    expect(refEntry(cut, S + "/whale", S + "/animals")).toBeNull();
    expect(byPair(cut, "/animals", "/whale")).toBe(1);
    expect(cut.stats.nonZero).toBe(all.stats.nonZero);
    expect(cut.stats.kept).toBeLessThan(all.stats.kept);
    expect(cut.entries.every((e) => e.ref > cut.epsilon)).toBe(true);
  });

  it("drops a score exactly equal to ε (only REF > ε survives)", () => {
    // Target terms {whale, fact, whale fact}; donor has 2 of 3 → unweighted 2/3.
    const m = model([page("/a", "", "Whale. Fact."), page("/b", "Whale facts", "")]);
    expect(refMatrix(m, "unweighted", { epsilon: 2 / 3, refExplainTerms: 10 }).entries).toEqual([]);
    const below = refMatrix(m, "unweighted", { epsilon: 0.66, refExplainTerms: 10 });
    expect(byPair(below, "/a", "/b")).toBe(2 / 3);
  });

  it("uses the configured default ε", () => {
    const m = refMatrix(site, "weighted", makeConfig());
    expect(m.epsilon).toBe(0.2);
    expect(m.entries.every((e) => e.ref > 0.2)).toBe(true);
  });

  it("never stores self-pairs or zero scores", () => {
    const m = refMatrix(site, "weighted", { epsilon: 0, refExplainTerms: 10 });
    expect(m.entries.every((e) => e.source !== e.target && e.ref > 0)).toBe(true);
  });
});

describe("per-node normalisation ρ", () => {
  const big = buildTextModel(
    {
      runId: 1,
      policyVersion: "P0@1.0.0",
      documents: syntheticSite({ pages: 60, vocabulary: 400, bodyWords: 60, anchors: 10, seed: 7 }),
    },
    makeConfig(),
  );
  const m = refMatrix(big, "weighted", { epsilon: 0.05, refExplainTerms: 5 });

  it("each source's ρ sums to 1 over its non-zero entries", () => {
    const sums = new Map<number, number>();
    for (const e of m.entries) sums.set(e.source, (sums.get(e.source) ?? 0) + e.rho);
    expect(sums.size).toBe(m.stats.sourcesWithEntries);
    expect(sums.size).toBeGreaterThan(10);
    for (const s of sums.values()) expect(s).toBeCloseTo(1, 12);
  });

  it("ρ is proportional to REF within a row", () => {
    const row = m.entries.filter((e) => e.source === m.entries[0]?.source);
    const sum = row.reduce((s, e) => s + e.ref, 0);
    for (const e of row) expect(e.rho).toBeCloseTo(e.ref / sum, 12);
  });

  it("a single surviving entry gets ρ = 1", () => {
    const one = refMatrix(site, "weighted", { epsilon: 0.9, refExplainTerms: 10 });
    const row = one.entries.filter((e) => one.nodes[e.source] === S + "/animals");
    expect(row).toHaveLength(1);
    expect(row[0]?.rho).toBe(1);
  });

  it("matches brute-force REF for every ordered pair", () => {
    const all = refMatrix(big, "weighted", { epsilon: 0, refExplainTerms: 1 });
    const unweighted = refMatrix(big, "unweighted", { epsilon: 0, refExplainTerms: 1 });
    const docs = [...big.documents].sort((a, b) => (a.node < b.node ? -1 : 1));
    let checked = 0;
    for (const a of docs) {
      for (const b of docs) {
        if (a === b) continue;
        const donor = new Set(a.donor);
        const tw = targetWeights(b);
        expect(refEntry(all, a.node, b.node)?.ref ?? 0).toBeCloseTo(ref(donor, tw, "weighted"), 12);
        expect(refEntry(unweighted, a.node, b.node)?.ref ?? 0).toBeCloseTo(
          ref(donor, tw, "unweighted"),
          12,
        );
        checked += 1;
      }
    }
    expect(checked).toBe(all.stats.pairs);
  });
});

describe("explanations (matched n-grams)", () => {
  it("lists the matched terms of a strong pair, largest contribution first", () => {
    const m = refMatrix(site, "weighted", { epsilon: 0.5, refExplainTerms: 10 });
    const e = refEntry(m, S + "/animals", S + "/whale");
    expect(e?.matched.map((x) => x.term).sort()).toEqual(["fact", "whale", "whale fact"]);
    expect(e?.matchedCount).toBe(3);
    const c = e?.matched.map((x) => x.contribution) ?? [];
    expect(c).toEqual([...c].sort((a, b) => b - a));
    // Every matched term is listed, so the contributions add up to REF.
    expect(c.reduce((s, x) => s + x, 0)).toBeCloseTo(e?.ref ?? 0, 12);
  });

  it("keeps only refExplainTerms terms, but counts them all", () => {
    const m = refMatrix(site, "weighted", { epsilon: 0.5, refExplainTerms: 1 });
    const e = refEntry(m, S + "/animals", S + "/whale");
    expect(e?.matched).toHaveLength(1);
    expect(e?.matchedCount).toBe(3);
  });

  it("uses 1/|S_B| contributions in the unweighted variant", () => {
    const m = refMatrix(site, "unweighted", { epsilon: 0.5, refExplainTerms: 10 });
    const e = refEntry(m, S + "/animals", S + "/whale");
    for (const x of e?.matched ?? []) expect(x.contribution).toBeCloseTo(1 / 3, 12);
  });
});

describe("output", () => {
  it("is sparse, sorted, versioned and independent of document order", () => {
    const one = refMatrix(site, "weighted", makeConfig());
    const reversed = refMatrix(
      { ...site, documents: [...site.documents].reverse() },
      "weighted",
      makeConfig(),
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(one));
    expect(one).toMatchObject({
      version: "ref@1.1.0",
      textVersion: "text@1.0.0",
      policyVersion: "P0@1.0.0",
      variant: "weighted",
      nodes: [S + "/animals", S + "/recipes", S + "/whale"],
    });
    expect(one.stats.pairs).toBe(6);
    const keys = one.entries.map((e) => e.source * 1000 + e.target);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  it("handles an empty model", () => {
    const m = refMatrix(model([]), "weighted", makeConfig());
    expect(m.entries).toEqual([]);
    expect(m.stats).toMatchObject({ nodes: 0, pairs: 0, kept: 0, maxRef: null });
  });
});
