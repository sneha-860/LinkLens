import { describe, expect, it } from "vitest";
import { graphsageLookup } from "./graphsage.js";

describe("graphsageLookup", () => {
  const nodes = ["https://s.test/a", "https://s.test/b", "https://s.test/c"];
  it("finds a scored pair by repeat, target and donor", () => {
    const look = graphsageLookup({
      nodes,
      repeats: [
        { repeat: 0, seed: 42, targets: [{ target: 2, donors: [0, 1], scores: [0.9, -0.5] }] },
        { repeat: 1, seed: 43, targets: [{ target: 0, donors: [2], scores: [0.1] }] },
      ],
    });
    expect(look(0, nodes[2] as string, nodes[0] as string)).toBe(0.9);
    expect(look(0, nodes[2] as string, nodes[1] as string)).toBe(-0.5);
    expect(look(1, nodes[0] as string, nodes[2] as string)).toBe(0.1);
    // Not scored: another repeat, target or donor.
    expect(look(1, nodes[2] as string, nodes[0] as string)).toBeUndefined();
    expect(look(2, nodes[2] as string, nodes[0] as string)).toBeUndefined();
  });

  it("refuses donors and scores of different lengths", () => {
    expect(() =>
      graphsageLookup({
        nodes,
        repeats: [{ repeat: 0, seed: 42, targets: [{ target: 0, donors: [1, 2], scores: [1] }] }],
      }),
    ).toThrow(/differ in length/);
  });
});
