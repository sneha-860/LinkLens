import { describe, expect, it } from "vitest";
import { extractPage } from "./extract.js";

const PAGE = "https://e.com/dir/page.html";

describe("extractPage", () => {
  const html = `<!doctype html>
<HTML lang="en-GB">
<head>
  <title>  My   Page </title>
  <link rel="alternate canonical" href="../Canonical/?a=1&amp;b=2">
  <meta name="ROBOTS" content="noindex,nofollow">
  <script>var x = "<a href='/not-a-link'>";</script>
  <style>p { color: red }</style>
</head>
<body>
  <header><a href="/">Home</a></header>
  <nav><ul><li><a href="a.html">A</a></li><li><a href="b.html" rel="nofollow">B</a></li></ul></nav>
  <main>
    <h1>Title <em>one</em></h1>
    <p>First   paragraph with <a href="#frag">a link</a>.</p>
    <h2>Sub</h2>
    <p>   </p>
    <div role="navigation"><a href="?q=1">Query</a></div>
    <a href="/img"><img src="x.png" alt="Logo"></a>
    <a href="/aria" aria-label="Labelled"></a>
    <map><area href="/area" alt="Area"></map>
    <a>No href</a>
  </main>
  <footer><a href="http://[bad">Bad</a></footer>
</body>
</HTML>`;
  const page = extractPage(html, PAGE);

  it("extracts title, h1, headings, lang, canonical and robots raw", () => {
    expect(page.title).toBe("My Page");
    expect(page.h1).toBe("Title one");
    expect(page.headings).toEqual([
      { level: 1, text: "Title one" },
      { level: 2, text: "Sub" },
    ]);
    expect(page.lang).toBe("en-GB");
    expect(page.metaCanonical).toBe("../Canonical/?a=1&b=2"); // entity-decoded, not resolved
    expect(page.metaRobots).toBe("noindex,nofollow");
  });

  it("extracts paragraphs and body text without script/style", () => {
    expect(page.paragraphs).toEqual(["First paragraph with a link."]);
    expect(page.bodyText).toContain("First paragraph");
    expect(page.bodyText).not.toContain("color: red");
    expect(page.bodyText).not.toContain("not-a-link");
  });

  it("extracts every a/area with href, in document order, hrefs raw", () => {
    expect(page.links.map((l) => l.rawHref)).toEqual([
      "/",
      "a.html",
      "b.html",
      "#frag",
      "?q=1",
      "/img",
      "/aria",
      "/area",
      "http://[bad",
    ]);
    expect(page.links.map((l) => l.positionIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("resolves against the page URL, keeping fragments, or null when invalid", () => {
    const r = Object.fromEntries(page.links.map((l) => [l.rawHref, l.resolvedUrl]));
    expect(r["a.html"]).toBe("https://e.com/dir/a.html");
    expect(r["#frag"]).toBe("https://e.com/dir/page.html#frag");
    expect(r["?q=1"]).toBe("https://e.com/dir/page.html?q=1");
    expect(r["http://[bad"]).toBeNull();
  });

  it("captures anchor text, alt/aria fallbacks and rel", () => {
    const by = Object.fromEntries(page.links.map((l) => [l.rawHref, l]));
    expect(by["#frag"]?.anchorText).toBe("a link");
    expect(by["/img"]?.anchorText).toBe("Logo");
    expect(by["/aria"]?.anchorText).toBe("Labelled");
    expect(by["/area"]?.anchorText).toBe("Area");
    expect(by["b.html"]?.rel).toBe("nofollow");
    expect(by["a.html"]?.rel).toBeNull();
  });

  it("assigns landmark regions (tags and ARIA roles)", () => {
    const by = Object.fromEntries(page.links.map((l) => [l.rawHref, l.domRegion]));
    expect(by).toMatchObject({
      "/": "header",
      "a.html": "nav",
      "#frag": "main",
      "?q=1": "nav",
      "/img": "main",
      "http://[bad": "footer",
    });
  });

  it("builds DOM paths with nth-of-type only where siblings share a tag", () => {
    const by = Object.fromEntries(page.links.map((l) => [l.rawHref, l.domPath]));
    expect(by["/"]).toBe("html>body>header>a");
    expect(by["a.html"]).toBe("html>body>nav>ul>li:nth-of-type(1)>a");
    expect(by["b.html"]).toBe("html>body>nav>ul>li:nth-of-type(2)>a");
    expect(by["/img"]).toBe("html>body>main>a:nth-of-type(1)");
  });

  it("honours <base href>", () => {
    const p = extractPage('<base href="https://cdn.e.com/x/"><a href="y">y</a>', PAGE);
    expect(p.links[0]?.resolvedUrl).toBe("https://cdn.e.com/x/y");
  });

  it("returns nulls for a minimal document", () => {
    const p = extractPage("", PAGE);
    expect(p).toMatchObject({
      title: null,
      h1: null,
      metaCanonical: null,
      metaRobots: null,
      lang: null,
      links: [],
    });
  });
});
