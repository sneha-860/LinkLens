import { describe, expect, it } from "vitest";
import { removeDotSegments, resolveReference, stripFragment } from "./rfc3986.js";

describe("resolveReference: RFC 3986 §5.4 examples", () => {
  const base = "http://a/b/c/d;p?q";

  // §5.4.1 Normal Examples
  it.each([
    ["g:h", "g:h"],
    ["g", "http://a/b/c/g"],
    ["./g", "http://a/b/c/g"],
    ["g/", "http://a/b/c/g/"],
    ["/g", "http://a/g"],
    ["//g", "http://g"],
    ["?y", "http://a/b/c/d;p?y"],
    ["g?y", "http://a/b/c/g?y"],
    ["#s", "http://a/b/c/d;p?q#s"],
    ["g#s", "http://a/b/c/g#s"],
    ["g?y#s", "http://a/b/c/g?y#s"],
    [";x", "http://a/b/c/;x"],
    ["g;x", "http://a/b/c/g;x"],
    ["g;x?y#s", "http://a/b/c/g;x?y#s"],
    ["", "http://a/b/c/d;p?q"],
    [".", "http://a/b/c/"],
    ["./", "http://a/b/c/"],
    ["..", "http://a/b/"],
    ["../", "http://a/b/"],
    ["../g", "http://a/b/g"],
    ["../..", "http://a/"],
    ["../../", "http://a/"],
    ["../../g", "http://a/g"],
  ])("normal: %j → %s", (ref, expected) => {
    expect(resolveReference(base, ref)).toBe(expected);
  });

  // §5.4.2 Abnormal Examples
  it.each([
    ["../../../g", "http://a/g"],
    ["../../../../g", "http://a/g"],
    ["/./g", "http://a/g"],
    ["/../g", "http://a/g"],
    ["g.", "http://a/b/c/g."],
    [".g", "http://a/b/c/.g"],
    ["g..", "http://a/b/c/g.."],
    ["..g", "http://a/b/c/..g"],
    ["./../g", "http://a/b/g"],
    ["./g/.", "http://a/b/c/g/"],
    ["g/./h", "http://a/b/c/g/h"],
    ["g/../h", "http://a/b/c/h"],
    ["g;x=1/./y", "http://a/b/c/g;x=1/y"],
    ["g;x=1/../y", "http://a/b/c/y"],
    ["g?y/./x", "http://a/b/c/g?y/./x"],
    ["g?y/../x", "http://a/b/c/g?y/../x"],
    ["g#s/./x", "http://a/b/c/g#s/./x"],
    ["g#s/../x", "http://a/b/c/g#s/../x"],
    ["http:g", "http:g"], // strict parser
  ])("abnormal: %j → %s", (ref, expected) => {
    expect(resolveReference(base, ref)).toBe(expected);
  });
});

describe("resolveReference: no normalisation beyond RFC 3986", () => {
  const base = "https://www.example.com/dir/page.html";

  it("keeps host case, default ports, percent-encoding and odd characters as written", () => {
    expect(resolveReference(base, "HTTPS://WWW.Example.COM:443/A%2fB")).toBe(
      "HTTPS://WWW.Example.COM:443/A%2fB",
    );
    expect(resolveReference(base, "/a b/ü?x=1&y=%7e")).toBe(
      "https://www.example.com/a b/ü?x=1&y=%7e",
    );
    expect(resolveReference(base, "a\\b")).toBe("https://www.example.com/dir/a\\b");
    expect(resolveReference(base, "?")).toBe("https://www.example.com/dir/page.html?");
    expect(resolveReference(base, "#")).toBe("https://www.example.com/dir/page.html#");
  });

  it("keeps the fragment and non-http schemes", () => {
    expect(resolveReference(base, "other.html#team")).toBe(
      "https://www.example.com/dir/other.html#team",
    );
    expect(resolveReference(base, "mailto:hi@example.com")).toBe("mailto:hi@example.com");
    expect(resolveReference(base, "javascript:void(0)")).toBe("javascript:void(0)");
  });

  it("strips only leading/trailing ASCII whitespace, as HTML requires for attribute URLs", () => {
    expect(resolveReference(base, " \t\n/x \r\n")).toBe("https://www.example.com/x");
    expect(resolveReference(base, "/a ")).toBe("https://www.example.com/a "); // NBSP is not ASCII whitespace
  });

  it("does not validate: an unusable reference still resolves textually", () => {
    expect(resolveReference(base, "http://[bad")).toBe("http://[bad");
  });

  it("rejects a relative base", () => {
    expect(() => resolveReference("/relative", "x")).toThrow(/absolute/);
  });
});

describe("removeDotSegments (RFC 3986 §5.2.4 examples)", () => {
  it.each([
    ["/a/b/c/./../../g", "/a/g"],
    ["mid/content=5/../6", "mid/6"],
    ["/..", "/"],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(removeDotSegments(input)).toBe(expected);
  });
});

describe("stripFragment", () => {
  it("drops everything from the first #", () => {
    expect(stripFragment("https://e.com/a?b#c#d")).toBe("https://e.com/a?b");
    expect(stripFragment("https://E.com/A")).toBe("https://E.com/A");
  });
});
