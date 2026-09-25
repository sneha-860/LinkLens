import { describe, expect, it } from "vitest";
import { parseInt8 } from "./pool.js";
import { resolveDatabaseUrl, withDatabase } from "./env.js";

describe("parseInt8", () => {
  it("parses safe integers", () => {
    expect(parseInt8("42")).toBe(42);
  });
  it("rejects values beyond MAX_SAFE_INTEGER", () => {
    expect(() => parseInt8("9007199254740993")).toThrow(RangeError);
  });
});

describe("resolveDatabaseUrl", () => {
  it("returns the trimmed URL", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: " postgres://a@b/c " })).toBe("postgres://a@b/c");
  });
  it("throws when missing or blank", () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL/);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });
});

describe("withDatabase", () => {
  it("swaps the database name, keeping credentials and port", () => {
    expect(withDatabase("postgres://u:p@localhost:5433/linklens", "other")).toBe(
      "postgres://u:p@localhost:5433/other",
    );
  });
});
