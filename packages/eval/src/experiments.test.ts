import { describe, expect, it } from "vitest";
import { experiments } from "./experiments.js";

describe("experiments registry", () => {
  it("lists E1–E8 in order with only E8 optional", () => {
    expect(experiments.map((e) => e.id)).toEqual(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]);
    expect(experiments.filter((e) => e.optional).map((e) => e.id)).toEqual(["E8"]);
  });
});
