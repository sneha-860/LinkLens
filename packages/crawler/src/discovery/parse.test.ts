import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  findFeedLinks,
  looksLikeSitemapLink,
  maybeGunzip,
  parseFeed,
  parseLlmsTxt,
  parseSitemap,
} from "./parse.js";

describe("parseSitemap", () => {
  it("reads a urlset with lastmod, trimming whitespace and decoding entities", () => {
    const s = parseSitemap(
      `<?xml version="1.0"?>
       <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc> https://e.com/a?x=1&amp;y=2 </loc><lastmod>2026-01-01</lastmod></url>
         <url><loc>https://e.com/b</loc></url>
         <url><changefreq>daily</changefreq></url>
       </urlset>`,
      100,
    );
    expect(s).toEqual({
      type: "urlset",
      truncated: false,
      entries: [
        { loc: "https://e.com/a?x=1&y=2", lastmod: "2026-01-01" },
        { loc: "https://e.com/b", lastmod: null },
      ],
    });
  });

  it("reads a sitemap index", () => {
    const s = parseSitemap(
      `<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap>
       <sitemap><loc>https://e.com/s2.xml.gz</loc></sitemap></sitemapindex>`,
      100,
    );
    expect(s.type).toBe("sitemapindex");
    expect(s.entries.map((e) => e.loc)).toEqual([
      "https://e.com/s1.xml",
      "https://e.com/s2.xml.gz",
    ]);
  });

  it("ignores namespace prefixes", () => {
    const s = parseSitemap(
      `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://e.com/</sm:loc></sm:url></sm:urlset>`,
      100,
    );
    expect(s.entries).toEqual([{ loc: "https://e.com/", lastmod: null }]);
  });

  it("caps entries at maxUrls and says so", () => {
    const xml = `<urlset>${Array.from({ length: 5 }, (_, i) => `<url><loc>/p${i}</loc></url>`).join("")}</urlset>`;
    const s = parseSitemap(xml, 3);
    expect(s.entries).toHaveLength(3);
    expect(s.truncated).toBe(true);
  });

  it.each(["<html><body>Not found</body></html>", "", "not xml at all", "<rss/>"])(
    "returns unknown for %j",
    (text) => {
      expect(parseSitemap(text, 10)).toEqual({ type: "unknown", entries: [], truncated: false });
    },
  );
});

describe("maybeGunzip", () => {
  it("gunzips by magic bytes, whatever the name or type", () => {
    const xml = "<urlset><url><loc>/x</loc></url></urlset>";
    const r = maybeGunzip(gzipSync(xml), 1_000_000);
    expect(r.gzipped).toBe(true);
    expect(new TextDecoder().decode(r.bytes)).toBe(xml);
  });

  it("passes plain bytes through", () => {
    const bytes = new TextEncoder().encode("<urlset/>");
    expect(maybeGunzip(bytes, 100)).toEqual({ bytes, gzipped: false });
  });

  it("refuses output beyond the cap (zip-bomb guard)", () => {
    expect(() => maybeGunzip(gzipSync("x".repeat(10_000)), 100)).toThrow();
  });
});

describe("parseFeed", () => {
  it("RSS 2.0: item links, falling back to a permalink guid", () => {
    const f = parseFeed(`<rss version="2.0"><channel><title>t</title><link>https://e.com/</link>
      <item><title>One</title><link> https://e.com/1 </link></item>
      <item><title>Two</title><guid>https://e.com/2</guid></item>
      <item><title>Three</title><guid isPermaLink="false">tag:e.com,3</guid></item>
    </channel></rss>`);
    expect(f).toEqual({
      format: "rss",
      entries: [
        { link: "https://e.com/1", title: "One" },
        { link: "https://e.com/2", title: "Two" },
      ],
    });
  });

  it("Atom: the alternate link of each entry (not the feed's own link, not rel=edit)", () => {
    const f = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><link href="https://e.com/"/>
      <entry><title>A</title><link rel="edit" href="https://e.com/edit"/><link rel="alternate" href="https://e.com/a"/></entry>
      <entry><title>B</title><link href="https://e.com/b"/></entry>
      <entry><title>C</title><link rel="enclosure" href="https://e.com/c.mp3"/></entry>
    </feed>`);
    expect(f).toEqual({
      format: "atom",
      entries: [
        { link: "https://e.com/a", title: "A" },
        { link: "https://e.com/b", title: "B" },
      ],
    });
  });

  it("RSS 1.0 (RDF)", () => {
    const f =
      parseFeed(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
      <item rdf:about="https://e.com/x"><title>X</title><link>https://e.com/x</link></item></rdf:RDF>`);
    expect(f).toEqual({ format: "rdf", entries: [{ link: "https://e.com/x", title: "X" }] });
  });

  it("returns unknown for non-feeds", () => {
    expect(parseFeed("<html><body>hi</body></html>")).toEqual({ format: "unknown", entries: [] });
    expect(parseFeed("")).toEqual({ format: "unknown", entries: [] });
  });
});

describe("findFeedLinks", () => {
  it("finds <link rel=alternate> feeds of every feed type, raw", () => {
    const links = findFeedLinks(`<head>
      <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
      <link rel="Alternate" type="APPLICATION/ATOM+XML" href="https://e.com/atom">
      <link rel="alternate" type="application/feed+json" href="/feed.json">
      <link rel="alternate" hreflang="fr" href="/fr/">
      <link rel="stylesheet" type="text/css" href="/s.css">
    </head>`);
    expect(links).toEqual([
      { href: "/feed.xml", type: "application/rss+xml", title: "RSS" },
      { href: "https://e.com/atom", type: "application/atom+xml", title: null },
      { href: "/feed.json", type: "application/feed+json", title: null },
    ]);
  });
});

describe("parseLlmsTxt", () => {
  it("takes Markdown links with their section, skipping images", () => {
    expect(
      parseLlmsTxt(`# Project

> summary with [a link](/intro)

## Docs
- [Guide](/guide.md): how to
- [API](<https://e.com/api> "title")  ![logo](/logo.png)

## Optional ##
- [Extra](extra.html)`),
    ).toEqual([
      { href: "/intro", text: "a link", section: null },
      { href: "/guide.md", text: "Guide", section: "Docs" },
      { href: "https://e.com/api", text: "API", section: "Docs" },
      { href: "extra.html", text: "Extra", section: "Optional" },
    ]);
  });

  it("returns nothing for text without links", () => {
    expect(parseLlmsTxt("# Title\n\nNo links here.")).toEqual([]);
  });
});

describe("looksLikeSitemapLink", () => {
  it.each([
    ["Sitemap", "/whatever", true],
    ["Site map", "/x", true],
    ["site-map", "/x", true],
    [null, "/sitemap", true],
    [null, "/sitemap.html", true],
    [null, "/site-map/", true],
    [null, "/html-sitemap?x=1", true],
    [null, "/sitemap.xml", false],
    ["Sitemaps of the world", "/x", false],
    ["Blog", "/blog/", false],
    [null, "/website-mapping", false],
  ])("%j %s → %s", (text, href, expected) => {
    expect(looksLikeSitemapLink(text, href)).toBe(expected);
  });
});
