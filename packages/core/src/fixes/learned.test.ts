import { describe, expect, it } from "vitest";
import { applyLearned } from "./learned.js";
import type { FixRecord } from "./scoring.js";

const fix = (id: string, target: string, rank: number, score: number): FixRecord =>
  ({
    id,
    donor: `d-${id}`,
    target,
    rank,
    targetRank: 1,
    score,
    scoreS: score,
    scoring: "S",
  }) as unknown as FixRecord;

describe("applyLearned", () => {
  const fixes = [
    fix("a", "T1", 1, 0.9),
    fix("b", "T1", 2, 0.5),
    fix("c", "T2", 3, 0.4),
    fix("d", "T2", 4, 0.1),
  ];
  const shap = [{ feature: "deltaPr", value: 0.01, contribution: 0.3 }];

  it("reorders by priority, keeps S, and ranks anew globally and per target", () => {
    const out = applyLearned(fixes, {
      fixes: {
        a: { priority: 0.2, raw: -1, shap },
        b: { priority: 0.8, raw: 1, shap },
        c: { priority: 0.5, raw: 0, shap },
        d: { priority: 0.5, raw: 0.2, shap }, // ties with c on priority; raw breaks it
      },
    });
    expect(out.map((f) => [f.id, f.rank, f.targetRank, f.score])).toEqual([
      ["b", 1, 1, 0.8],
      ["d", 2, 1, 0.5],
      ["c", 3, 2, 0.5],
      ["a", 4, 2, 0.2],
    ]);
    expect(out.every((f) => f.scoring === "learned")).toBe(true);
    expect(out.find((f) => f.id === "a")?.scoreS).toBe(0.9);
    expect(out[0]?.learned?.shap).toEqual(shap);
  });

  it("puts fixes without a priority last, in their S order", () => {
    const out = applyLearned(fixes, { fixes: { c: { priority: 0.1, raw: 0, shap: [] } } });
    expect(out.map((f) => f.id)).toEqual(["c", "a", "b", "d"]);
    expect(out[1]).toMatchObject({ learned: null, score: 0 });
  });
});
