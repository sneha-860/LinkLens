import { describe, expect, it } from "vitest";
import { makeConfig, type SigmaVariant } from "../config.js";
import type { Candidate } from "./candidates.js";
import type { CounterfactualResult } from "./counterfactual.js";
import {
  fixScore,
  scoreFixes,
  sigmaValues,
  topK,
  topKPerTarget,
  type ScoringInput,
} from "./scoring.js";

const config = makeConfig(); // ε 0.2, λ 0.5, σ refGateCosine

describe("sigmaValues", () => {
  it("computes every variant", () => {
    expect(sigmaValues(0.5, 0.8, config)).toEqual({
      cosineOnly: 0.8,
      refOnly: 0.5,
      refGateCosine: 0.8,
      blended: 0.65,
    });
  });

  it("gates cosine on REF > ε (REF = ε is not enough)", () => {
    expect(sigmaValues(0.1, 0.8, config).refGateCosine).toBe(0);
    expect(sigmaValues(0.2, 0.8, config).refGateCosine).toBe(0);
    expect(sigmaValues(0.21, 0.8, config).refGateCosine).toBe(0.8);
  });

  it("blends with the configured λ", () => {
    expect(sigmaValues(0.5, 0.8, { ...config, sigmaBlendLambda: 1 }).blended).toBe(0.5);
    expect(sigmaValues(0.5, 0.8, { ...config, sigmaBlendLambda: 0 }).blended).toBe(0.8);
    expect(sigmaValues(0.4, 0.8, { ...config, sigmaBlendLambda: 0.25 }).blended).toBeCloseTo(
      0.7,
      15,
    );
  });

  it("counts a missing cosine as 0", () => {
    expect(sigmaValues(0.5, null, config)).toEqual({
      cosineOnly: 0,
      refOnly: 0.5,
      refGateCosine: 0,
      blended: 0.25,
    });
  });
});

describe("fixScore", () => {
  it("is ΔPR × σ / κ", () => {
    expect(fixScore(0.02, 0.9, 3)).toBeCloseTo(0.006, 15);
    expect(fixScore(0.02, 0, 1)).toBe(0);
  });
});

// ---------- a constructed example ----------
// [donor, target, action, REF, cosine, ΔPR, κ(donor)]
type Row = [string, string, Candidate["action"], number, number | null, number];
const ROWS: Row[] = [
  ["A", "T1", "add-link", 0.5, 0.8, 0.01],
  ["B", "T1", "make-visible", 0.3, 0.9, 0.02],
  ["C", "T1", "add-link", 0.25, null, 0.05],
  ["A", "T2", "add-link", 0.6, 0.5, 0.004],
  ["D", "T2", "add-link", 0.4, -0.2, 0.03],
];
const KAPPA: Record<string, number> = { A: 1, B: 3, C: 1, D: 2 };

const candidate = ([donor, target, action, ref]: Row): Candidate => ({
  id: `${action}:${donor}->${target}`,
  donor,
  target,
  action,
  rank: 1,
  ref,
  rho: ref / 2,
  existingLink:
    action === "make-visible" ? { omega: 0.05, bodyLink: true, regions: { body: 1 } } : null,
  targetReasons: ["deep-page"],
  diagnosis: donor === "A" ? "v4" : null,
  section: { donor: "s", target: "s", relation: "same" },
  reasons: [],
});
const result = ([donor, target, action, , , dpr]: Row): CounterfactualResult => ({
  candidateId: `${action}:${donor}->${target}`,
  donor,
  target,
  action,
  weightBefore: action === "make-visible" ? 0.1 : 0,
  weightAfter: 1,
  prBefore: 0.01,
  prAfter: 0.01 + dpr,
  deltaPrTarget: dpr,
  deltaPrL1: 2 * dpr,
  depthBefore: 5,
  depthAfter: 2,
  deltaDepth: -3,
  iterations: 12,
  converged: true,
});
const input = (rows: Row[] = ROWS): ScoringInput => ({
  policyVersion: "P0@1.0.0",
  candidates: rows.map(candidate),
  results: rows.map(result),
  cosine: (u, v) => rows.find(([d, t]) => d === u && t === v)?.[4] ?? null,
  effort: new Map(
    Object.entries(KAPPA).map(([n, kappa]) => [n, { kappa, templateReach: kappa * 2 }]),
  ),
});
const order = (variant: SigmaVariant) =>
  scoreFixes(input(), { ...config, sigmaVariant: variant }).map((f) => `${f.donor}→${f.target}`);

describe("scoreFixes", () => {
  const fixes = scoreFixes(input(), config);
  const fix = (d: string, t: string) => fixes.find((f) => f.donor === d && f.target === t);

  it("scores S = ΔPR × σ / κ with the default σ (cosine gated by REF > ε)", () => {
    expect(fixes.map((f) => [`${f.donor}→${f.target}`, Number(f.score.toFixed(6))])).toEqual([
      ["A→T1", 0.008], // 0.01 × 0.8 / 1
      ["B→T1", 0.006], // 0.02 × 0.9 / 3
      ["A→T2", 0.002], // 0.004 × 0.5 / 1
      ["C→T1", 0], // no cosine
      ["D→T2", -0.003], // negative cosine: ranked last
    ]);
  });

  it("ranks globally and per target", () => {
    expect(fixes.map((f) => [f.rank, f.targetRank])).toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
      [4, 3],
      [5, 2],
    ]);
  });

  it("fills every field of the fix record", () => {
    expect(fix("B", "T1")).toEqual({
      id: "make-visible:B->T1",
      donor: "B",
      target: "T1",
      type: "make-visible",
      deltaPr: 0.02,
      deltaPrL1: 0.04,
      deltaDepth: -3,
      depthBefore: 5,
      depthAfter: 2,
      sigmaVariant: "refGateCosine",
      sigma: 0.9,
      sigmas: { cosineOnly: 0.9, refOnly: 0.3, refGateCosine: 0.9, blended: 0.6 },
      ref: 0.3,
      rho: 0.15,
      cosine: 0.9,
      prominence: { omega: 0.05, weightBefore: 0.1, weightAfter: 1 },
      kappa: 3,
      templateReach: 6,
      score: fixScore(0.02, 0.9, 3),
      rank: 2,
      targetRank: 2,
      targetReasons: ["deep-page"],
      diagnosis: null,
      policyVersion: "P0@1.0.0",
    });
    expect(fix("C", "T1")).toMatchObject({ cosine: null, sigma: 0, prominence: { omega: null } });
  });

  it("ranks differently under each σ variant (E7)", () => {
    expect(order("refGateCosine")).toEqual(["A→T1", "B→T1", "A→T2", "C→T1", "D→T2"]);
    // cosineOnly equals the gate here: every candidate already has REF > ε.
    expect(order("cosineOnly")).toEqual(order("refGateCosine"));
    // refOnly: C 0.0125, D 0.006, A→T1 0.005, A→T2 0.0024, B 0.002.
    expect(order("refOnly")).toEqual(["C→T1", "D→T2", "A→T1", "A→T2", "B→T1"]);
    // blended (λ 0.5): A→T1 0.0065, C 0.00625, B 0.004, A→T2 0.0022, D 0.0015.
    expect(order("blended")).toEqual(["A→T1", "C→T1", "B→T1", "A→T2", "D→T2"]);
  });

  it("reports every variant on each record, whichever one scores", () => {
    const blended = scoreFixes(input(), { ...config, sigmaVariant: "blended" });
    for (const f of blended) {
      expect(f.sigma).toBe(f.sigmas.blended);
      expect(f.sigmas).toEqual(fixes.find((g) => g.id === f.id)?.sigmas);
    }
  });

  it("breaks score ties by ΔPR, then donor, then target", () => {
    const tied: Row[] = [
      ["B", "T", "add-link", 0.5, 0.5, 0.02],
      ["A", "T", "add-link", 0.5, 1, 0.01], // same score 0.01, smaller ΔPR
      ["C", "T", "add-link", 0.5, 0.5, 0.02], // same score and ΔPR as B: donor order
    ];
    const flat = new Map(["A", "B", "C"].map((d) => [d, { kappa: 1, templateReach: 1 }]));
    const ranked = scoreFixes({ ...input(tied), effort: flat }, config).map((f) => f.donor);
    expect(ranked).toEqual(["B", "C", "A"]);
  });

  it("is deterministic and independent of input order", () => {
    const reversed: ScoringInput = {
      ...input(),
      candidates: [...input().candidates].reverse(),
      results: [...input().results].reverse(),
    };
    expect(JSON.stringify(scoreFixes(reversed, config))).toBe(JSON.stringify(fixes));
  });

  it("refuses a candidate without a counterfactual result or donor effort", () => {
    expect(() => scoreFixes({ ...input(), results: input().results.slice(1) }, config)).toThrow(
      /no counterfactual result/,
    );
    expect(() => scoreFixes({ ...input(), effort: new Map() }, config)).toThrow(
      /no editing effort/,
    );
  });
});

describe("top-k", () => {
  // 60 fixes over 4 targets with distinct, deterministic scores.
  const rows: Row[] = Array.from({ length: 60 }, (_, i) => [
    `D${String(i).padStart(2, "0")}`,
    `T${i % 4}`,
    "add-link",
    0.5,
    1,
    (60 - i) / 1000,
  ]);
  const big: ScoringInput = {
    ...input(rows),
    effort: new Map(rows.map(([d]) => [d, { kappa: 1, templateReach: 1 }])),
  };
  const ranked = scoreFixes(big, config);

  it.each([10, 25, 50])("returns the top %i overall, in rank order", (k) => {
    const top = topK(ranked, k);
    expect(top).toHaveLength(k);
    expect(top.map((f) => f.rank)).toEqual(Array.from({ length: k }, (_, i) => i + 1));
    expect(top[0]?.donor).toBe("D00");
  });

  it.each([10, 25, 50])("returns at most %i per target", (k) => {
    const per = topKPerTarget(ranked, k);
    expect([...per.keys()]).toEqual(["T0", "T1", "T2", "T3"]);
    for (const list of per.values()) {
      expect(list).toHaveLength(Math.min(k, 15));
      expect(list.map((f) => f.targetRank)).toEqual(list.map((_, i) => i + 1));
    }
  });

  it("returns everything when k exceeds the list", () => {
    expect(topK(ranked, 100)).toHaveLength(60);
  });
});
