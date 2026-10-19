import { describe, expect, it } from "vitest";
import { rescueStep } from "./rescue.js";
import { makeScope } from "./scope.js";

const inScope = makeScope(new URL("https://site.test/"), false);
const none = new Set<string>();

describe("rescueStep (what rescue does with one orphan, before any request)", () => {
  it("fetches an in-scope orphan's first raw URL", () => {
    const step = rescueStep(
      ["https://site.test/orphan", "https://site.test/orphan/"],
      none,
      inScope,
    );
    expect(step).toMatchObject({ kind: "fetch", raw: "https://site.test/orphan" });
  });

  it("never requests a URL outside the crawl scope", () => {
    expect(rescueStep(["https://elsewhere.test/page"], none, inScope)).toEqual({
      kind: "out-of-scope",
      raw: "https://elsewhere.test/page",
      error: "rescue: outside the crawl scope, not fetched",
    });
    expect(rescueStep(["https://sub.site.test/page"], none, inScope)).toMatchObject({
      kind: "out-of-scope",
    });
  });

  it("records an unparsable URL instead of requesting it", () => {
    expect(rescueStep(["http://[bad"], none, inScope)).toMatchObject({
      kind: "invalid",
      error: "rescue: not a valid URL, not fetched",
    });
  });

  it("skips an orphan any of whose URLs was already fetched, and one without a URL", () => {
    const done = new Set(["https://site.test/orphan/"]);
    expect(
      rescueStep(["https://site.test/orphan", "https://site.test/orphan/"], done, inScope),
    ).toEqual({ kind: "already-fetched" });
    expect(rescueStep([], none, inScope)).toEqual({ kind: "no-url" });
  });
});
