import { describe, expect, it } from "vitest";
import { cosineOf, cosineUpper, embeddingInput, packedIndex, type CosineMatrix } from "./cosine.js";

const v = (...xs: number[]) => Float32Array.from(xs);

describe("embeddingInput", () => {
  it("joins title and h1 (unless they repeat) and the body", () => {
    const doc = { node: "n", fetchId: 1, url: "u", links: ["ignored anchor"] };
    expect(
      embeddingInput({ ...doc, title: ["Blue Whale | Acme", "Blue whale"], body: [" Big. "] }),
    ).toEqual({
      node: "n",
      title: "Blue Whale | Acme\nBlue whale",
      body: "Big.",
    });
    expect(embeddingInput({ ...doc, title: ["Blue Whale", " blue whale "], body: [] })).toEqual({
      node: "n",
      title: "Blue Whale",
      body: "",
    });
  });
});

describe("packedIndex", () => {
  it("enumerates the strict upper triangle row by row", () => {
    const n = 4;
    const seen: number[] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) seen.push(packedIndex(n, i, j));
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    expect(() => packedIndex(4, 2, 2)).toThrow(RangeError);
    expect(() => packedIndex(4, 1, 4)).toThrow(RangeError);
  });
});

describe("cosineUpper", () => {
  it("computes cosine for every pair, independent of vector length", () => {
    const up = cosineUpper([v(1, 0), v(0, 2), v(3, 3), v(-1, 0)]);
    expect([...up].map((x) => Number(x.toFixed(6)))).toEqual([
      0, 0.707107, -1, 0.707107, 0, -0.707107,
    ]);
  });

  it("gives 0 for a zero vector and handles 0 or 1 vectors", () => {
    expect([...cosineUpper([v(0, 0), v(1, 1)])]).toEqual([0]);
    expect(cosineUpper([v(1)]).length).toBe(0);
    expect(cosineUpper([]).length).toBe(0);
  });

  it("rejects vectors of different dimensions", () => {
    expect(() => cosineUpper([v(1, 0), v(1)])).toThrow(RangeError);
  });
});

describe("cosineOf", () => {
  const m: CosineMatrix = {
    version: "cosine@1.0.0",
    runId: 1,
    policyVersion: "P0@1.0.0",
    model: "m",
    dtype: "fp32",
    bodyTokens: 256,
    dimensions: 2,
    nodes: ["a", "b", "c"],
    contentKeys: ["ka", "kb", "kc"],
    upper: [...cosineUpper([v(1, 0), v(0, 1), v(1, 1)])],
  };

  it("is symmetric, 1 on the diagonal, null for unknown nodes", () => {
    expect(cosineOf(m, "a", "c")).toBeCloseTo(Math.SQRT1_2);
    expect(cosineOf(m, "c", "a")).toBe(cosineOf(m, "a", "c"));
    expect(cosineOf(m, "a", "b")).toBe(0);
    expect(cosineOf(m, "b", "b")).toBe(1);
    expect(cosineOf(m, "a", "zzz")).toBeNull();
  });
});
