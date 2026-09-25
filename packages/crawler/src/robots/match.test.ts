import { describe, expect, it } from "vitest";
import { compileRules, decide, patternMatches, selectGroups } from "./match.js";
import { normalisePattern } from "./normalise.js";
import { parseRobots } from "./parse.js";
import { RobotsPolicy } from "./policy.js";

const base = "https://www.example.com";
const allowed = (robots: string, ua: string, path: string) =>
  RobotsPolicy.fromText(robots, ua).isAllowed(base + path);

describe("patternMatches", () => {
  const m = (pattern: string, target: string) => patternMatches(normalisePattern(pattern), target);

  it("is a prefix match by default", () => {
    expect(m("/fish", "/fish")).toBe(true);
    expect(m("/fish", "/fish.html")).toBe(true);
    expect(m("/fish", "/fishheads/yummy.html")).toBe(true);
    expect(m("/fish", "/Fish.asp")).toBe(false); // case-sensitive
    expect(m("/fish", "/catfish")).toBe(false);
  });

  it("treats a trailing * as redundant", () => {
    for (const t of ["/fish", "/fish.html", "/fishheads"]) expect(m("/fish*", t)).toBe(true);
    expect(m("/fish*", "/catfish")).toBe(false);
  });

  it("matches * across path segments", () => {
    expect(m("/*.php", "/index.php")).toBe(true);
    expect(m("/*.php", "/folder/filename.php?parameters")).toBe(true);
    expect(m("/*.php", "/folder/any.php.file.html")).toBe(true);
    expect(m("/*.php", "/")).toBe(false);
    expect(m("/*.php", "/windows.PHP")).toBe(false);
  });

  it("anchors on a trailing $", () => {
    expect(m("/*.php$", "/filename.php")).toBe(true);
    expect(m("/*.php$", "/folder/filename.php")).toBe(true);
    expect(m("/*.php$", "/filename.php?parameters")).toBe(false);
    expect(m("/*.php$", "/filename.php/")).toBe(false);
    expect(m("/*.php$", "/filename.php5")).toBe(false);
    expect(m("/this/path/exactly$", "/this/path/exactly")).toBe(true);
    expect(m("/this/path/exactly$", "/this/path/exactly/not")).toBe(false);
  });

  it("combines * in the middle", () => {
    expect(m("/fish*.php", "/fish.php")).toBe(true);
    expect(m("/fish*.php", "/fishheads/catfish.php?parameters")).toBe(true);
    expect(m("/fish*.php", "/Fish.PHP")).toBe(false);
    expect(m("/this/*/exactly", "/this/a/b/exactly")).toBe(true);
  });

  it("handles a lone * and a lone $", () => {
    expect(m("*", "/anything")).toBe(true);
    expect(m("/$", "/")).toBe(true);
    expect(m("/$", "/a")).toBe(false);
  });

  it("handles consecutive and many wildcards without blowing up", () => {
    expect(m("/a**b", "/axxb")).toBe(true);
    const hostile = "/" + "*a".repeat(40) + "b";
    const target = "/" + "a".repeat(5000);
    const start = performance.now();
    expect(m(hostile, target)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("RFC 9309 §5.1 example", () => {
  const robots = [
    "User-Agent: *",
    "Disallow: *.gif$",
    "Disallow: /example/",
    "Allow: /publications/",
    "",
    "User-Agent: foobot",
    "Disallow:/",
    "Allow:/example/page.html",
    "Allow:/example/allowed.gif",
    "",
    "User-Agent: barbot",
    "User-Agent: bazbot",
    "Disallow: /example/page.html",
    "",
    "User-Agent: quxbot",
    "",
    "EOF",
  ].join("\n");

  it("foobot: only the two allowed pages", () => {
    expect(allowed(robots, "foobot", "/example/page.html")).toBe(true);
    expect(allowed(robots, "foobot", "/example/allowed.gif")).toBe(true);
    expect(allowed(robots, "foobot", "/example/other.html")).toBe(false);
    expect(allowed(robots, "foobot", "/")).toBe(false);
    expect(allowed(robots, "foobot", "/publications/")).toBe(false); // * group does not apply
  });

  it("barbot and bazbot share a group", () => {
    for (const ua of ["barbot", "bazbot"]) {
      expect(allowed(robots, ua, "/example/page.html")).toBe(false);
      expect(allowed(robots, ua, "/example/other.html")).toBe(true);
      expect(allowed(robots, ua, "/image.gif")).toBe(true);
    }
  });

  it("quxbot: a matching group with no rules allows everything (no fallback to *)", () => {
    expect(allowed(robots, "quxbot", "/example/")).toBe(true);
    expect(allowed(robots, "quxbot", "/image.gif")).toBe(true);
  });

  it("any other crawler falls back to *", () => {
    expect(allowed(robots, "LinkLensBot/0.1", "/image.gif")).toBe(false);
    expect(allowed(robots, "LinkLensBot/0.1", "/image.gif?x")).toBe(true); // $ anchors
    expect(allowed(robots, "LinkLensBot/0.1", "/example/")).toBe(false);
    expect(allowed(robots, "LinkLensBot/0.1", "/publications/")).toBe(true);
    expect(allowed(robots, "LinkLensBot/0.1", "/other")).toBe(true);
  });
});

describe("RFC 9309 §5.2 longest match", () => {
  const robots =
    "User-Agent: foobot\nAllow: /example/page/\nDisallow: /example/page/disallowed.gif";

  it("uses the rule with the most octets", () => {
    expect(allowed(robots, "foobot", "/example/page/")).toBe(true);
    expect(allowed(robots, "foobot", "/example/page/allowed.html")).toBe(true);
    expect(allowed(robots, "foobot", "/example/page/disallowed.gif")).toBe(false);
  });
});

describe("precedence", () => {
  it("prefers allow when allow and disallow are equally long", () => {
    expect(allowed("user-agent: *\ndisallow: /page\nallow: /page", "x", "/page")).toBe(true);
    expect(allowed("user-agent: *\nallow: /page\ndisallow: /page", "x", "/page")).toBe(true);
  });

  it("counts wildcard characters toward length", () => {
    // "/*.html" (7) is longer than "/page" (5): disallow wins on /page.html
    const robots = "user-agent: *\nallow: /page\ndisallow: /*.html";
    expect(allowed(robots, "x", "/page.html")).toBe(false);
    expect(allowed(robots, "x", "/page.htm")).toBe(true);
  });

  it("measures length after percent-encoding normalisation", () => {
    // "/ツ" normalises to "/%E3%83%84" (10 octets) and beats "/%E3%83" (7)
    const robots = "user-agent: *\ndisallow: /%E3%83\nallow: /ツ";
    expect(allowed(robots, "x", "/ツ")).toBe(true);
  });

  it("lets Allow: /$ open only the root under Disallow: /", () => {
    const robots = "user-agent: *\ndisallow: /\nallow: /$";
    expect(allowed(robots, "x", "/")).toBe(true);
    expect(allowed(robots, "x", "/a")).toBe(false);
    expect(allowed(robots, "x", "/?q=1")).toBe(false);
  });

  it("allows everything when no rule matches", () => {
    const d = RobotsPolicy.fromText("user-agent: *\ndisallow: /private", "x").check(
      `${base}/public`,
    );
    expect(d).toEqual({ allowed: true, rule: null, reason: "no-match" });
  });

  it("reports the winning rule with its source line", () => {
    const d = RobotsPolicy.fromText("user-agent: *\n\ndisallow: /private", "x").check(
      `${base}/private/a`,
    );
    expect(d.allowed).toBe(false);
    expect(d.rule).toMatchObject({ type: "disallow", pattern: "/private", line: 3 });
  });

  it("always allows /robots.txt", () => {
    const d = RobotsPolicy.fromText("user-agent: *\ndisallow: /", "x").check(`${base}/robots.txt`);
    expect(d).toEqual({ allowed: true, rule: null, reason: "robots-txt-always-allowed" });
  });
});

describe("percent-encoding in matching (RFC 9309 §2.2.2, §2.2.3)", () => {
  it.each([
    ["/foo/bar?baz=quz", "/foo/bar?baz=quz"],
    ["/foo/bar/ツ", "/foo/bar/%E3%83%84"],
    ["/foo/bar/%E3%83%84", "/foo/bar/%E3%83%84"],
    ["/foo/bar/%62%61%7A", "/foo/bar/baz"],
  ])("pattern %s matches URL path %s", (pattern, path) => {
    expect(allowed(`user-agent: *\ndisallow: ${pattern}`, "x", path)).toBe(false);
  });

  it("matches an unencoded UTF-8 URL against an encoded pattern", () => {
    expect(allowed("user-agent: *\ndisallow: /foo/bar/%E3%83%84", "x", "/foo/bar/ツ")).toBe(false);
  });

  it("%2A in a pattern matches a literal * and is not a wildcard", () => {
    const robots = "user-agent: *\ndisallow: /path/file-with-a-%2A.html";
    expect(allowed(robots, "x", "/path/file-with-a-*.html")).toBe(false);
    expect(allowed(robots, "x", "/path/file-with-a-b.html")).toBe(true);
  });

  it("%24 in a pattern matches a literal $ and is not an anchor", () => {
    const robots = "user-agent: *\ndisallow: /path/foo-%24";
    expect(allowed(robots, "x", "/path/foo-$")).toBe(false);
    expect(allowed(robots, "x", "/path/foo-$/more")).toBe(false);
    expect(allowed(robots, "x", "/path/foo-")).toBe(true);
  });

  it("hex case does not matter", () => {
    expect(allowed("user-agent: *\ndisallow: /a%2fb", "x", "/a%2Fb")).toBe(false);
  });

  it("ignores the fragment", () => {
    expect(allowed("user-agent: *\ndisallow: /a$", "x", "/a#section")).toBe(false);
  });
});

describe("selectGroups: user-agent matching (RFC 9309 §2.2.1)", () => {
  it("matches the product token case-insensitively", () => {
    const robots = "user-agent: LINKLENSBOT\ndisallow: /x";
    expect(allowed(robots, "LinkLensBot/0.1 (+https://e.org)", "/x")).toBe(false);
  });

  it("matches a user-agent line that carries a version", () => {
    expect(allowed("user-agent: LinkLensBot/2.0\ndisallow: /x", "LinkLensBot/0.1", "/x")).toBe(
      false,
    );
  });

  it("prefers a specific group over * and does not merge them", () => {
    const robots = "user-agent: *\ndisallow: /a\n\nuser-agent: linklensbot\ndisallow: /b";
    expect(allowed(robots, "LinkLensBot", "/a")).toBe(true);
    expect(allowed(robots, "LinkLensBot", "/b")).toBe(false);
  });

  it("merges all groups that name the same crawler", () => {
    const robots = [
      "user-agent: ExampleBot",
      "disallow: /foo",
      "disallow: /bar",
      "",
      "user-agent: *",
      "disallow: /all",
      "",
      "user-agent: examplebot",
      "disallow: /baz",
    ].join("\n");
    for (const p of ["/foo", "/bar", "/baz"]) expect(allowed(robots, "ExampleBot", p)).toBe(false);
    expect(allowed(robots, "ExampleBot", "/all")).toBe(true);
  });

  it("merges multiple * groups", () => {
    const robots = "user-agent: *\ndisallow: /a\n\nuser-agent: *\ndisallow: /b";
    expect(allowed(robots, "x", "/a")).toBe(false);
    expect(allowed(robots, "x", "/b")).toBe(false);
  });

  it("does not match a longer or shorter product token", () => {
    const robots = "user-agent: LinkLens\ndisallow: /a\n\nuser-agent: LinkLensBotPro\ndisallow: /b";
    expect(allowed(robots, "LinkLensBot", "/a")).toBe(true);
    expect(allowed(robots, "LinkLensBot", "/b")).toBe(true);
  });

  it("allows everything when neither a specific nor a * group exists", () => {
    expect(allowed("user-agent: otherbot\ndisallow: /", "LinkLensBot", "/x")).toBe(true);
  });

  it("returns the selected groups", () => {
    const parsed = parseRobots("user-agent: a\ndisallow: /1\nuser-agent: *\ndisallow: /2");
    expect(selectGroups(parsed, "a").map((g) => g.userAgents)).toEqual([["a"]]);
    expect(selectGroups(parsed, "b").map((g) => g.userAgents)).toEqual([["*"]]);
  });
});

describe("decide", () => {
  it("works directly on compiled rules", () => {
    const rules = compileRules(parseRobots("user-agent: *\ndisallow: /x").groups);
    expect(decide(rules, new URL(`${base}/x/y`)).allowed).toBe(false);
    expect(rules[0]).toMatchObject({ normalised: "/x", length: 2 });
  });
});
