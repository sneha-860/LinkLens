import { describe, expect, it } from "vitest";
import { followUpConfig } from "./run-config.js";

const stored = {
  userAgent: "LinkLensBot/0.1 (+https://example.org/bot)",
  crawlDelayMs: 500,
  discoveryMaxFetches: 100,
};

describe("followUpConfig (discovery and rescue)", () => {
  it("applies overrides that make fetching more polite", () => {
    const c = followUpConfig(stored, { crawlDelayMs: 2_000, discoveryMaxFetches: 2 });
    expect(c).toMatchObject({ crawlDelayMs: 2_000, discoveryMaxFetches: 2 });
  });

  it("refuses overrides that would speed fetching up or enlarge a cap", () => {
    expect(() => followUpConfig(stored, { crawlDelayMs: 0 })).toThrow(
      /config\.crawlDelayMs 0 is less polite than 500/,
    );
    expect(() => followUpConfig(stored, { discoveryMaxFetches: 1_000 })).toThrow(
      /discoveryMaxFetches/,
    );
    expect(() => followUpConfig(stored, { rescueMaxFetches: 10_000 })).toThrow(/rescueMaxFetches/);
  });

  it("leaves a stored run's own page cap alone (a research crawl's 2000, say)", () => {
    expect(followUpConfig({ ...stored, pageCap: 2_000 }).pageCap).toBe(2_000);
    expect(() => followUpConfig({ ...stored, pageCap: 2_000 }, { pageCap: 3_000 })).toThrow(
      /pageCap/,
    );
  });

  it("checks the User-Agent again, stored or overridden", () => {
    expect(() => followUpConfig(stored, { userAgent: "Anon/1.0" })).toThrow(
      /userAgent is not identifying: missing contact URL/,
    );
    expect(() => followUpConfig({ ...stored, userAgent: "curl/8" })).toThrow(/userAgent/);
  });
});
