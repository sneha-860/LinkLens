import { describe, expect, it } from "vitest";
import { isHttpUrl, makeScope, requestKey, resolveHref } from "./scope.js";

describe("requestKey", () => {
  it("drops only the fragment", () => {
    expect(requestKey(new URL("https://e.com/A/b.html?x=1&a=2#frag"))).toBe(
      "https://e.com/A/b.html?x=1&a=2",
    );
  });

  it("does not normalise anything else", () => {
    const keys = [
      "https://e.com/about.html",
      "https://e.com/About.html",
      "https://e.com/about.html?",
      "https://e.com/about.html?ref=nav",
      "https://e.com/blog",
      "https://e.com/blog/",
      "https://e.com/blog/index.html",
      "http://e.com/about.html",
    ].map((u) => requestKey(new URL(u)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps what WHATWG parsing itself produces (host case, default port, dot segments)", () => {
    expect(requestKey(new URL("HTTPS://E.COM:443/a/../b"))).toBe("https://e.com/b");
  });
});

describe("resolveHref", () => {
  it("resolves relative hrefs against the base", () => {
    expect(resolveHref("../x?y#z", "https://e.com/a/b/c.html")?.toString()).toBe(
      "https://e.com/a/x?y#z",
    );
  });
  it("returns null for invalid URLs", () => {
    expect(resolveHref("http://[bad", "https://e.com/")).toBeNull();
  });
});

describe("isHttpUrl", () => {
  it.each([
    ["https://e.com/", true],
    ["http://e.com/", true],
    ["mailto:a@b.c", false],
    ["javascript:void(0)", false],
    ["ftp://e.com/", false],
  ])("%s → %s", (u, expected) => {
    expect(isHttpUrl(new URL(u))).toBe(expected);
  });
});

describe("makeScope", () => {
  const seed = new URL("https://www.example.com/");

  it("exact: same host only, either scheme", () => {
    const inScope = makeScope(seed, false);
    expect(inScope(new URL("https://www.example.com/a"))).toBe(true);
    expect(inScope(new URL("http://WWW.EXAMPLE.COM/a"))).toBe(true);
    expect(inScope(new URL("https://example.com/a"))).toBe(false);
    expect(inScope(new URL("https://blog.example.com/a"))).toBe(false);
    expect(inScope(new URL("https://www.example.com:8443/a"))).toBe(false);
    expect(inScope(new URL("mailto:x@www.example.com"))).toBe(false);
  });

  it("includeSubdomains: the base domain (minus www.) and its subdomains", () => {
    const inScope = makeScope(seed, true);
    expect(inScope(new URL("https://example.com/"))).toBe(true);
    expect(inScope(new URL("https://blog.example.com/"))).toBe(true);
    expect(inScope(new URL("https://a.b.example.com/"))).toBe(true);
    expect(inScope(new URL("https://notexample.com/"))).toBe(false);
    expect(inScope(new URL("https://example.com.evil.test/"))).toBe(false);
    expect(inScope(new URL("https://blog.example.com:8443/"))).toBe(false);
  });

  it("respects a non-default seed port", () => {
    const inScope = makeScope(new URL("http://127.0.0.1:4000/"), false);
    expect(inScope(new URL("http://127.0.0.1:4000/x"))).toBe(true);
    expect(inScope(new URL("http://127.0.0.1:4001/x"))).toBe(false);
  });
});
