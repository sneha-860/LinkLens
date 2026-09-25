import { describe, expect, it } from "vitest";
import { defaultConfig, makeConfig } from "@linklens/core";
import { checkUserAgent, productToken, requestHeaders } from "./user-agent.js";

describe("productToken", () => {
  it.each([
    ["LinkLensBot/0.1 (+contact URL)", "LinkLensBot"],
    ["Foo_Bar-bot", "Foo_Bar-bot"],
    ["  spaced/1", "spaced"],
  ])("%s → %s", (ua, token) => {
    expect(productToken(ua)).toBe(token);
  });

  it("rejects a UA without a product token", () => {
    expect(() => productToken("/1.0")).toThrow(/product token/);
    expect(() => productToken("")).toThrow();
  });

  it("works for the default config", () => {
    expect(productToken(defaultConfig.userAgent)).toBe("LinkLensBot");
  });
});

describe("checkUserAgent", () => {
  it("accepts a fully identifying UA", () => {
    expect(checkUserAgent("LinkLensBot/0.1 (+https://example.org/linklens)")).toEqual([]);
  });

  it("flags the placeholder contact in the default config", () => {
    expect(checkUserAgent(defaultConfig.userAgent)).toEqual([
      "missing contact URL in the form (+https://…)",
    ]);
  });

  it("flags a missing version", () => {
    expect(checkUserAgent("LinkLensBot (+https://e.org)")).toEqual(["missing version (Token/x.y)"]);
  });

  it("flags everything for garbage", () => {
    expect(checkUserAgent("!!")).toHaveLength(3);
  });
});

describe("requestHeaders", () => {
  it("sends config.userAgent", () => {
    const cfg = makeConfig({ userAgent: "LinkLensBot/0.1 (+https://e.org)" });
    expect(requestHeaders(cfg)).toEqual({ "User-Agent": "LinkLensBot/0.1 (+https://e.org)" });
  });
});
