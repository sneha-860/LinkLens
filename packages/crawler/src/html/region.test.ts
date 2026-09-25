import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import type { Element } from "domhandler";
import { describe, expect, it } from "vitest";
import { extractPage } from "../extract.js";
import { classifyRegion, elementRegion } from "./region.js";

const SITE = fileURLToPath(new URL("../../test/fixtures/site/", import.meta.url));
const O = "http://fixture.test";

/** [rawHref, anchorText, region] for every link of a fixture page, in document order. */
function regionsOf(file: string, url: string): [string, string | null, string][] {
  const page = extractPage(readFileSync(SITE + file, "utf8"), url);
  return page.links.map((l) => [l.rawHref, l.anchorText, l.domRegion]);
}

/** Region of the first element matching `selector` in an HTML snippet. */
function regionIn(html: string, selector = "a"): string {
  const $ = load(html);
  return classifyRegion($(selector).get(0) as Element);
}

describe("classifyRegion on the fixture pages", () => {
  it("index.html: semantic header>nav, main, footer", () => {
    const r = regionsOf("index.html", `${O}/`);
    expect(r.slice(0, 7).map((x) => x[2])).toEqual(Array(7).fill("nav")); // <header><nav>
    expect(r.filter((x) => x[2] === "main")).toHaveLength(16); // <main> list
    expect(r.slice(-5).map((x) => x[2])).toEqual(Array(5).fill("footer")); // <footer>
    expect(new Set(r.map((x) => x[2]))).toEqual(new Set(["nav", "main", "footer"]));
  });

  it("about.html: class/id heuristics and ARIA roles, no semantic tags", () => {
    expect(regionsOf("about.html", `${O}/about.html`)).toEqual([
      ["/", "Home", "header"], // #masthead.site-header
      ["/", "Home", "nav"], // .main-navigation > ul.menu (nav inside header stays nav)
      ["/about.html", "About", "nav"],
      ["/blog/", "Blog", "nav"],
      ["/blog/", "blog", "main"], // #content.site-content
      ["/", "Home", "aside"], // .sidebar
      ["/about.html", "About", "footer"], // role=contentinfo
    ]);
  });

  it("blog/index.html: breadcrumb, pagination, and <header> inside <article> is content", () => {
    expect(regionsOf("blog/index.html", `${O}/blog/`)).toEqual([
      ["/", "Home", "nav"],
      ["/about.html", "About", "nav"],
      ["/blog/", "Blog", "nav"],
      ["../", "Home", "breadcrumb"], // <nav aria-label="Breadcrumb">
      ["/blog/", "Blog", "breadcrumb"],
      ["post-1.html", "Post one", "main"], // <article><header>
      ["/blog/post-2.html", "Post two", "main"],
      ["/nofollow-page.html", "Nofollow page", "main"],
      ["/blog/post-1.html", "1", "pagination"], // <nav class="pagination">
      ["/blog/post-2.html", "2", "pagination"],
    ]);
  });

  it("blog/post-1.html: schema.org breadcrumb, rel=next, nav inside aside/footer", () => {
    expect(regionsOf("blog/post-1.html", `${O}/blog/post-1.html`)).toEqual([
      ["/", "Home", "nav"], // <header><nav>
      ["/blog/", "Blog", "nav"],
      ["/", "Home", "breadcrumb"], // ol.breadcrumbs[itemtype=BreadcrumbList]
      ["/blog/", "Blog", "breadcrumb"],
      ["/about.html", "About the author", "main"], // article > footer.entry-footer
      ["/blog/post-2.html", "Next post", "pagination"], // rel="next"
      ["/blog/", "Back to blog", "main"],
      ["/about.html", "About", "aside"], // <aside><nav>
      ["/", "Home", "footer"], // <footer><nav>
    ]);
  });

  it("pages without any region signal default to body", () => {
    const r = regionsOf("deep/1.html", `${O}/deep/1.html`);
    expect(r.map((x) => x[2])).toEqual(["body", "body"]);
  });
});

describe("classifyRegion: individual signals", () => {
  it.each([
    ['<nav><a href="/">x</a></nav>', "nav"],
    ['<div role="navigation"><a href="/">x</a></div>', "nav"],
    ['<div id="topnav"><a href="/">x</a></div>', "nav"],
    ['<ul class="navbar-nav"><li><a href="/">x</a></li></ul>', "nav"],
    ['<header><a href="/">x</a></header>', "header"],
    ['<div role="banner"><a href="/">x</a></div>', "header"],
    ['<div class="site-header"><a href="/">x</a></div>', "header"],
    ['<footer><a href="/">x</a></footer>', "footer"],
    ['<div id="colophon"><a href="/">x</a></div>', "footer"],
    ['<aside><a href="/">x</a></aside>', "aside"],
    ['<div role="complementary"><a href="/">x</a></div>', "aside"],
    ['<div id="sidebar"><a href="/">x</a></div>', "aside"],
    ['<main><a href="/">x</a></main>', "main"],
    ['<div role="main"><a href="/">x</a></div>', "main"],
    ['<article><a href="/">x</a></article>', "main"],
    ['<div class="entry-content"><a href="/">x</a></div>', "main"],
    ['<nav aria-label="breadcrumb"><a href="/">x</a></nav>', "breadcrumb"],
    ['<div class="yoast-breadcrumbs"><a href="/">x</a></div>', "breadcrumb"],
    ['<ul class="page-numbers"><li><a href="/">x</a></li></ul>', "pagination"],
    ['<nav aria-label="Page navigation"><a href="/">x</a></nav>', "pagination"],
    ['<div class="pager"><a href="/">x</a></div>', "pagination"],
    ['<a href="/p/3" rel="prev">x</a>', "pagination"],
    ['<div><p><a href="/">x</a></p></div>', "body"],
  ])("%s → %s", (html, expected) => {
    expect(regionIn(html)).toBe(expected);
  });

  it("treats header/footer inside sectioning content as that section's, not page chrome", () => {
    expect(regionIn('<article><header><a href="/">x</a></header></article>')).toBe("main");
    expect(regionIn('<section><footer><a href="/">x</a></footer></section>')).toBe("body");
    expect(regionIn('<main><div class="entry-header"><a href="/">x</a></div></main>')).toBe("main");
  });

  it("uses the nearest region, except that nav inside footer/aside reports the outer one", () => {
    expect(regionIn('<header><nav><a href="/">x</a></nav></header>')).toBe("nav");
    expect(regionIn('<footer><nav><a href="/">x</a></nav></footer>')).toBe("footer");
    expect(regionIn('<aside><ul class="menu"><li><a href="/">x</a></li></ul></aside>')).toBe(
      "aside",
    );
    expect(regionIn('<main><aside><a href="/">x</a></aside></main>')).toBe("aside");
    expect(regionIn('<footer><div class="pagination"><a href="/">x</a></div></footer>')).toBe(
      "pagination",
    );
  });

  it("does not match class words inside longer words", () => {
    expect(regionIn('<div class="navigational-hint unfooterish"><a href="/">x</a></div>')).toBe(
      "body",
    );
    expect(regionIn('<div class="menuitem"><a href="/">x</a></div>')).toBe("body");
  });

  it("classifies a single element without looking at ancestors", () => {
    const $ = load('<footer><nav id="n"><a href="/">x</a></nav></footer>');
    expect(elementRegion($("#n").get(0) as Element)).toBe("nav");
    expect(elementRegion($("a").get(0) as Element)).toBeNull();
    expect(elementRegion($("body").get(0) as Element)).toBeNull();
  });
});
