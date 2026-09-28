import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import type { FixRatingRow } from "../db/types.js";
import type { FixRecord } from "../fixes/scoring.js";
import {
  blindItems,
  cohensKappa,
  latestAnswers,
  precisionAtK,
  sampleForRating,
  summariseRatings,
  weightedKappa,
} from "./rating.js";

const fix = (rank: number): FixRecord =>
  ({
    id: `add-link:https://s.test/d${rank}->https://s.test/t${rank}`,
    donor: `https://s.test/d${rank}`,
    target: `https://s.test/t${rank}`,
    type: rank % 3 === 0 ? "make-visible" : "add-link",
    rank,
    score: 1 / rank,
  }) as unknown as FixRecord;
const fixes = Array.from({ length: 80 }, (_, i) => fix(i + 1));
const context = {
  title: (n: string) => `Title of ${n.slice(-2)}`,
  placement: () => null,
};

describe("sampleForRating", () => {
  it("draws from the top of the ranking, in a seeded order that is not the rank", () => {
    const items = sampleForRating(fixes, context, { pool: 50, size: 50, seed: 42 });
    expect(items).toHaveLength(50);
    expect(new Set(items.map((i) => i.rank))).toEqual(
      new Set(Array.from({ length: 50 }, (_, i) => i + 1)),
    );
    expect(items.map((i) => i.position)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(items.map((i) => i.rank)).not.toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(sampleForRating(fixes, context, { pool: 50, size: 50, seed: 42 })).toEqual(items);
    expect(sampleForRating(fixes, context, { pool: 50, size: 50, seed: 43 })).not.toEqual(items);
    const some = sampleForRating(fixes, context, { pool: 60, size: 20, seed: 1 });
    expect(some).toHaveLength(20);
    expect(some.every((i) => i.rank <= 60)).toBe(true);
    expect(some[0]).toMatchObject({
      donorTitle: expect.stringContaining("Title of"),
      placement: null,
    });
  });

  it("gives raters no rank or score", () => {
    const blind = blindItems(sampleForRating(fixes, context, { pool: 50, size: 50, seed: 42 }));
    for (const b of blind) {
      expect(b).not.toHaveProperty("rank");
      expect(b).not.toHaveProperty("score");
    }
    expect(blind.map((b) => b.position)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe("kappa", () => {
  it("matches hand-computed Cohen's kappa", () => {
    // p_o = 4/6, p_e = ½·½ + ½·½ = ½ → κ = (2/3 − ½) / ½ = ⅓.
    expect(cohensKappa([1, 1, 0, 0, 1, 0], [1, 0, 0, 0, 1, 1])).toBeCloseTo(1 / 3, 12);
    expect(cohensKappa(["x", "y"], ["x", "y"])).toBe(1);
    // Systematic disagreement on balanced labels: κ = −1.
    expect(cohensKappa([true, false], [false, true])).toBe(-1);
    // Everyone said the same one label: p_e = 1, undefined.
    expect(cohensKappa([true, true], [true, true])).toBeNull();
    expect(cohensKappa([], [])).toBeNull();
    expect(() => cohensKappa([1], [])).toThrow();
  });

  it("weights ordinal disagreements linearly", () => {
    const order = ["good", "acceptable", "poor"] as const;
    expect(weightedKappa(["good", "poor"], ["good", "poor"], order)).toBe(1);
    // One step apart counts half as much as two steps apart.
    const near = weightedKappa(
      ["good", "acceptable", "poor", "good"],
      ["acceptable", "acceptable", "poor", "good"],
      order,
    );
    const far = weightedKappa(
      ["good", "acceptable", "poor", "good"],
      ["poor", "acceptable", "poor", "good"],
      order,
    );
    expect(near as number).toBeGreaterThan(far as number);
    // Unweighted kappa does not tell them apart.
    expect(
      cohensKappa(
        ["good", "acceptable", "poor", "good"],
        ["acceptable", "acceptable", "poor", "good"],
      ),
    ).toBeCloseTo(
      cohensKappa(
        ["good", "acceptable", "poor", "good"],
        ["poor", "acceptable", "poor", "good"],
      ) as number,
      1,
    );
    expect(() => weightedKappa(["na"], ["good"], order as unknown as string[])).toThrow();
  });
});

describe("precision@k and the summary", () => {
  const items = sampleForRating(fixes, context, { pool: 10, size: 10, seed: 7 });
  let id = 0;
  const row = (
    rater: "A" | "B",
    rank: number,
    relevant: boolean,
    placement: FixRatingRow["placement"] = relevant ? "good" : "na",
  ): FixRatingRow => ({
    id: ++id,
    runId: 1,
    sampleArtefactId: 9,
    itemId: fix(rank).id,
    rater,
    raterName: rater === "A" ? "Ana" : "Ben",
    relevant,
    placement,
    ratedAt: new Date(0),
  });

  it("counts the rated items with rank ≤ k", () => {
    const p = precisionAtK(
      items,
      (i) => (i.endsWith("t1") || i.endsWith("t2") ? true : i.endsWith("t3") ? false : undefined),
      [2, 5, 1],
    );
    expect(p).toEqual([
      { k: 1, rated: 1, relevant: 1, precision: 1 },
      { k: 2, rated: 2, relevant: 2, precision: 1 },
      { k: 5, rated: 3, relevant: 2, precision: 2 / 3 },
    ]);
  });

  it("uses each rater's latest answer and reports kappa over items both rated", () => {
    const rows = [
      // A changes their mind on rank 1: the later row counts.
      row("A", 1, false),
      row("A", 1, true, "good"),
      row("A", 2, true, "acceptable"),
      row("A", 3, false),
      row("A", 4, true, "poor"),
      row("B", 1, true, "good"),
      row("B", 2, true, "poor"),
      row("B", 3, true, "acceptable"),
      row("B", 4, true, "poor"),
      row("B", 5, false),
    ];
    expect(latestAnswers(rows).get("A")?.get(fix(1).id)?.relevant).toBe(true);
    const s = summariseRatings(items, rows, makeConfig({ ratingKs: [2, 5] }));
    expect(s.raters.map((r) => [r.rater, r.name, r.rated, r.relevant])).toEqual([
      ["A", "Ana", 4, 3],
      ["B", "Ben", 5, 4],
    ]);
    expect(s.raters[0]?.precisionAtK).toEqual([
      { k: 2, rated: 2, relevant: 2, precision: 1 },
      { k: 5, rated: 4, relevant: 3, precision: 0.75 },
    ]);
    // Both rated ranks 1–4; relevance agrees on 1, 2, 4 (3 of 4).
    expect(s.agreement.items).toBe(4);
    expect(s.agreement.relevance.observed).toBe(0.75);
    // A: T,T,F,T; B: T,T,T,T → p_e = ¾·1 + ¼·0 = ¾, p_o = ¾ → κ = 0.
    expect(s.agreement.relevance.kappa).toBe(0);
    // Placement over items both marked relevant: ranks 1, 2, 4 → good/good, acceptable/poor, poor/poor.
    expect(s.agreement.placement.items).toBe(3);
    expect(s.agreement.placement.observed).toBeCloseTo(2 / 3, 12);
    expect(s.agreement.placement.weightedKappa).not.toBeNull();
    // Strict consensus at k = 5: relevant to both on 1, 2, 4 of the 4 both rated.
    expect(s.consensus.strict.at(-1)).toEqual({ k: 5, rated: 4, relevant: 3, precision: 0.75 });
    expect(s.consensus.mean.at(-1)?.precision).toBeCloseTo((0.75 + 0.8) / 2, 12);
  });

  it("ignores rows for items outside the sample and handles no ratings", () => {
    const outside = { ...row("A", 70, true), itemId: fix(70).id };
    const s = summariseRatings(items, [outside], makeConfig({ ratingKs: [5] }));
    expect(s.raters[0]?.rated).toBe(0);
    expect(s.agreement.relevance.kappa).toBeNull();
    expect(s.consensus.mean[0]?.precision).toBeNull();
  });
});
