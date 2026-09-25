import { describe, expect, it } from "vitest";
import { matchTarget, normaliseOctets, normalisePattern } from "./normalise.js";

describe("normaliseOctets (RFC 9309 §2.2.2 table)", () => {
  it.each([
    ["/foo/bar?baz=quz", "/foo/bar?baz=quz"],
    ["/foo/bar/ツ", "/foo/bar/%E3%83%84"],
    ["/foo/bar/%E3%83%84", "/foo/bar/%E3%83%84"],
    ["/foo/bar/%62%61%7A", "/foo/bar/baz"],
  ])("%s → %s", (input, expected) => {
    expect(normaliseOctets(input)).toBe(expected);
  });

  it("upper-cases hex of reserved escapes but keeps them encoded", () => {
    expect(normaliseOctets("/a%2fb%3f")).toBe("/a%2Fb%3F");
  });

  it("decodes every unreserved escape", () => {
    expect(normaliseOctets("%41%7a%30%2D%2E%5F%7E")).toBe("Az0-._~");
  });

  it("leaves a bare % that is not an escape", () => {
    expect(normaliseOctets("/100%/x%zz")).toBe("/100%/x%zz");
  });

  it("encodes space and astral code points as UTF-8", () => {
    expect(normaliseOctets("/a b/😀")).toBe("/a%20b/%F0%9F%98%80");
  });
});

describe("normalisePattern", () => {
  it("keeps * and a trailing $ as operators", () => {
    expect(normalisePattern("/*.gif$")).toBe("/*.gif$");
  });

  it("turns a non-trailing $ into a literal %24", () => {
    expect(normalisePattern("/a$b")).toBe("/a%24b");
  });

  it("keeps %2A and %24 as literal escapes", () => {
    expect(normalisePattern("/file-%2a.html")).toBe("/file-%2A.html");
    expect(normalisePattern("/foo-%24")).toBe("/foo-%24");
  });
});

describe("matchTarget", () => {
  it("uses path plus query and drops the fragment", () => {
    expect(matchTarget(new URL("https://e.com/a/b?x=1#frag"))).toBe("/a/b?x=1");
  });

  it("uses / for an empty path", () => {
    expect(matchTarget(new URL("https://e.com"))).toBe("/");
  });

  it("encodes literal * and $ so only %2A / %24 patterns match them", () => {
    expect(matchTarget(new URL("https://e.com/path/file-with-a-*.html"))).toBe(
      "/path/file-with-a-%2A.html",
    );
    expect(matchTarget(new URL("https://e.com/path/foo-$"))).toBe("/path/foo-%24");
  });

  it("normalises unreserved escapes in the URL", () => {
    expect(matchTarget(new URL("https://e.com/foo/bar/%62%61%7A"))).toBe("/foo/bar/baz");
  });
});
