import { describe, expect, it } from "vitest";
import { decodeRobots, parseRobots } from "./parse.js";

describe("parseRobots: records and grouping (RFC 9309 §2.1–2.2)", () => {
  it("groups consecutive user-agent lines and attaches following rules", () => {
    const r = parseRobots(
      ["User-Agent: barbot", "User-Agent: bazbot", "Disallow: /example/page.html"].join("\n"),
    );
    expect(r.groups).toEqual([
      {
        userAgents: ["barbot", "bazbot"],
        rules: [{ type: "disallow", pattern: "/example/page.html", line: 3 }],
        crawlDelaySeconds: null,
      },
    ]);
  });

  it("starts a new group when a user-agent line follows a rule", () => {
    const r = parseRobots("user-agent: a\ndisallow: /x\nuser-agent: b\ndisallow: /y");
    expect(r.groups.map((g) => g.userAgents)).toEqual([["a"], ["b"]]);
  });

  it("does not end a group on blank lines", () => {
    const r = parseRobots("user-agent: a\n\n\ndisallow: /x\n\nallow: /x/y");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.rules).toHaveLength(2);
  });

  it("keeps a group with a user-agent but no rules", () => {
    const r = parseRobots("User-Agent: quxbot\n");
    expect(r.groups).toEqual([{ userAgents: ["quxbot"], rules: [], crawlDelaySeconds: null }]);
  });

  it("ignores rules that appear before any user-agent line", () => {
    const r = parseRobots("disallow: /orphan\nuser-agent: *\ndisallow: /x");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.rules.map((x) => x.pattern)).toEqual(["/x"]);
  });

  it("treats keys case-insensitively and trims whitespace around keys and values", () => {
    const r = parseRobots("  USER-AGENT :  FooBot  \n\tDISALLOW\t:\t/a b \n aLLoW: /c");
    expect(r.groups[0]?.userAgents).toEqual(["FooBot"]);
    expect(r.groups[0]?.rules.map((x) => [x.type, x.pattern])).toEqual([
      ["disallow", "/a b"],
      ["allow", "/c"],
    ]);
  });

  it("strips full-line and trailing comments", () => {
    const r = parseRobots(
      "# comment\nuser-agent: * # everyone\ndisallow: /x # no x\n#disallow: /y",
    );
    expect(r.groups[0]?.userAgents).toEqual(["*"]);
    expect(r.groups[0]?.rules.map((x) => x.pattern)).toEqual(["/x"]);
  });

  it("ignores an empty Disallow/Allow value (allows everything)", () => {
    const r = parseRobots("user-agent: *\ndisallow:\nallow:");
    expect(r.groups[0]?.rules).toEqual([]);
  });

  it("ignores unknown keys and lines without a colon, without ending the group", () => {
    const r = parseRobots(
      "user-agent: a\nhost: example.com\nnonsense line\nclean-param: x\ndisallow: /x",
    );
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.rules.map((x) => x.pattern)).toEqual(["/x"]);
  });

  it("handles CRLF, CR-only line endings and a UTF-8 BOM", () => {
    const crlf = parseRobots("\uFEFFuser-agent: *\r\ndisallow: /a\r\n");
    const cr = parseRobots("user-agent: *\rdisallow: /a\r");
    expect(crlf.groups[0]?.rules[0]?.pattern).toBe("/a");
    expect(cr.groups[0]?.rules[0]?.pattern).toBe("/a");
  });

  it("records 1-based line numbers for provenance", () => {
    const r = parseRobots("\n# c\nuser-agent: *\n\ndisallow: /x");
    expect(r.groups[0]?.rules[0]?.line).toBe(5);
  });

  it("keeps rule values raw (no normalisation on parse)", () => {
    const r = parseRobots("user-agent: *\ndisallow: /Foo/%62ar/ツ");
    expect(r.groups[0]?.rules[0]?.pattern).toBe("/Foo/%62ar/ツ");
  });

  it("parses empty and comment-only files to no groups", () => {
    expect(parseRobots("").groups).toEqual([]);
    expect(parseRobots("# nothing here\n\n").groups).toEqual([]);
  });
});

describe("parseRobots: sitemap directives", () => {
  it("collects every sitemap line, raw and in order, regardless of position", () => {
    const r = parseRobots(
      [
        "Sitemap: https://example.com/sitemap.xml",
        "user-agent: *",
        "disallow: /x",
        "SITEMAP:   https://example.com/news.xml  ",
        "sitemap: /relative.xml",
      ].join("\n"),
    );
    expect(r.sitemaps).toEqual([
      { url: "https://example.com/sitemap.xml", line: 1 },
      { url: "https://example.com/news.xml", line: 4 },
      { url: "/relative.xml", line: 5 },
    ]);
  });

  it("does not let a sitemap line split a user-agent group", () => {
    const r = parseRobots(
      "user-agent: a\nsitemap: https://e.com/s.xml\nuser-agent: b\ndisallow: /x",
    );
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.userAgents).toEqual(["a", "b"]);
  });

  it("ignores empty sitemap values", () => {
    expect(parseRobots("sitemap:\n").sitemaps).toEqual([]);
  });
});

describe("parseRobots: crawl-delay", () => {
  it.each([
    ["5", 5],
    ["0.5", 0.5],
    [".25", 0.25],
    ["0", 0],
  ])("parses %s", (value, expected) => {
    expect(parseRobots(`user-agent: *\ncrawl-delay: ${value}`).groups[0]?.crawlDelaySeconds).toBe(
      expected,
    );
  });

  it.each(["abc", "-1", "1e3", "", "5s", "Infinity"])("ignores invalid value %j", (value) => {
    expect(
      parseRobots(`user-agent: *\ncrawl-delay: ${value}`).groups[0]?.crawlDelaySeconds,
    ).toBeNull();
  });

  it("uses the last valid value within a group", () => {
    expect(
      parseRobots("user-agent: *\ncrawl-delay: 1\ncrawl-delay: 3").groups[0]?.crawlDelaySeconds,
    ).toBe(3);
  });

  it("ignores crawl-delay outside any group", () => {
    expect(parseRobots("crawl-delay: 10\nuser-agent: *").groups[0]?.crawlDelaySeconds).toBeNull();
  });
});

describe("decodeRobots: size limit (RFC 9309 §2.5)", () => {
  const enc = new TextEncoder();

  it("passes small files through untouched", () => {
    expect(decodeRobots(enc.encode("user-agent: *\ndisallow: /"), 1000)).toEqual({
      text: "user-agent: *\ndisallow: /",
      truncated: false,
    });
  });

  it("truncates at the byte limit and drops the partial last line", () => {
    const bytes = enc.encode("user-agent: *\ndisallow: /a\ndisallow: /abcdef");
    const { text, truncated } = decodeRobots(bytes, 30); // cuts inside the 3rd line
    expect(truncated).toBe(true);
    expect(text).toBe("user-agent: *\ndisallow: /a");
    expect(parseRobots(text, truncated).truncated).toBe(true);
  });

  it("decodes UTF-8", () => {
    expect(decodeRobots(enc.encode("disallow: /ツ"), 100).text).toBe("disallow: /ツ");
  });
});
