import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPage } from "./extract.js";

const PAGE = "https://e.com/dir/page.html";
const SITE = fileURLToPath(new URL("../test/fixtures/site/", import.meta.url));
const fixture = (file: string, url: string) => extractPage(readFileSync(SITE + file, "utf8"), url);

describe("extractPage: links", () => {
  const html = `<!doctype html>
<HTML lang="en-GB">
<head><title>  My   Page </title></head>
<body>
  <nav><ul><li><a href="a.html">A</a></li><li><a href="b.html" rel="nofollow">B</a></li></ul></nav>
  <main>
    <p>Text with <a href="#frag">a link</a>.</p>
    <a href="/img"><img src="x.png" alt="Logo"></a>
    <a href="/img2"><img src="x.png" alt="Pic"> and text</a>
    <a href="/aria" aria-label="Labelled"></a>
    <a href="/empty"></a>
    <a>No href</a>
    <map><area href="/area" alt="Area"></map>
    <a href=" HTTP://Other.EXAMPLE:80/X/../Y?b=2&amp;a=1#F ">Other</a>
    <a href="mailto:hi@example.com">Mail</a>
    <a href="http://[bad">Bad</a>
  </main>
</body>
</HTML>`;
  const page = extractPage(html, PAGE);
  const by = Object.fromEntries(page.links.map((l) => [l.rawHref, l]));

  it("takes every <a href> (not <area>, not <a> without href) in document order", () => {
    expect(page.links.map((l) => l.rawHref)).toEqual([
      "a.html",
      "b.html",
      "#frag",
      "/img",
      "/img2",
      "/aria",
      "/empty",
      " HTTP://Other.EXAMPLE:80/X/../Y?b=2&a=1#F ",
      "mailto:hi@example.com",
      "http://[bad",
    ]);
    expect(page.links.map((l) => l.positionIndex)).toEqual([...Array(10).keys()]);
  });

  it("resolves against the page URL with RFC 3986 only (no normalisation, fragment kept)", () => {
    expect(by["a.html"]?.resolvedUrl).toBe("https://e.com/dir/a.html");
    expect(by["#frag"]?.resolvedUrl).toBe("https://e.com/dir/page.html#frag");
    expect(by[" HTTP://Other.EXAMPLE:80/X/../Y?b=2&a=1#F "]?.resolvedUrl).toBe(
      "HTTP://Other.EXAMPLE:80/Y?b=2&a=1#F",
    );
    expect(by["mailto:hi@example.com"]?.resolvedUrl).toBe("mailto:hi@example.com");
    expect(by["http://[bad"]?.resolvedUrl).toBe("http://[bad");
  });

  it("uses img alt as anchor text for image links, alongside any text", () => {
    expect(by["/img"]?.anchorText).toBe("Logo");
    expect(by["/img2"]?.anchorText).toBe("Pic and text");
    expect(by["#frag"]?.anchorText).toBe("a link");
    expect(by["/aria"]?.anchorText).toBe("Labelled");
    expect(by["/empty"]?.anchorText).toBeNull();
  });

  it("keeps rel raw", () => {
    expect(by["b.html"]?.rel).toBe("nofollow");
    expect(by["a.html"]?.rel).toBeNull();
  });

  it("honours <base href> (resolved against the page URL itself)", () => {
    const p = extractPage('<base href="../other/"><base href="/ignored/"><a href="y">y</a>', PAGE);
    expect(p.links[0]?.resolvedUrl).toBe("https://e.com/other/y");
    const abs = extractPage('<base href="https://cdn.e.com/x/"><a href="y#z">y</a>', PAGE);
    expect(abs.links[0]?.resolvedUrl).toBe("https://cdn.e.com/x/y#z");
  });
});

describe("extractPage: dom_path and template_signature", () => {
  it("builds short paths from the nearest id or from <body>", () => {
    const about = fixture("about.html", "http://f.test/about.html");
    expect(about.links.map((l) => l.domPath)).toEqual([
      "div#masthead>a",
      "ul#menu-primary>li:nth-of-type(1)>a",
      "ul#menu-primary>li:nth-of-type(2)>a",
      "ul#menu-primary>li:nth-of-type(3)>a",
      "div#content>p:nth-of-type(2)>a",
      "div:nth-of-type(3)>a",
      "div:nth-of-type(4)>a:nth-of-type(1)",
      "div:nth-of-type(4)>a:nth-of-type(2)",
    ]);
    const home = fixture("index.html", "http://f.test/");
    expect(home.links[2]?.domPath).toBe("header>nav>ul>li:nth-of-type(3)>a");
  });

  it("gives every link of one block the same 16-hex signature", () => {
    const about = fixture("about.html", "http://f.test/about.html");
    const [logo, ...rest] = about.links;
    const menu = rest.slice(0, 3).map((l) => l.templateSignature);
    expect(new Set(menu).size).toBe(1);
    expect(menu[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(logo?.templateSignature).not.toBe(menu[0]);
  });

  it("gives the same block the same signature across pages, despite current-item classes", () => {
    const about = fixture("about.html", "http://f.test/about.html");
    const blog = fixture("blog/index.html", "http://f.test/blog/");
    const aboutMenu = about.links.find((l) => l.domPath === "ul#menu-primary>li:nth-of-type(3)>a");
    const blogMenu = blog.links.find((l) => l.domPath === "ul#menu-primary>li:nth-of-type(3)>a");
    expect(aboutMenu?.templateSignature).toBeDefined();
    expect(blogMenu?.templateSignature).toBe(aboutMenu?.templateSignature);
    // …and different blocks differ: the breadcrumb is not the menu.
    const crumb = blog.links.find((l) => l.domRegion === "breadcrumb");
    expect(crumb?.templateSignature).not.toBe(blogMenu?.templateSignature);
  });

  it("ignores digits, state classes and positions, but not structure", () => {
    const sig = (html: string) => extractPage(html, PAGE).links[0]?.templateSignature;
    const a = sig('<ul class="menu"><li class="item-1 active"><a href="/">x</a></li></ul>');
    expect(sig('<ul class="menu"><li class="item-22"><a href="/">x</a></li></ul>')).toBe(a);
    expect(sig('<ul class="menu"><li class="item-3 is-open"><a href="/">x</a></li></ul>')).toBe(a);
    expect(
      sig('<ul class="menu"><li class="item-1"><span><a href="/">x</a></span></li></ul>'),
    ).not.toBe(a);
    expect(sig('<ol class="menu"><li class="item-1"><a href="/">x</a></li></ol>')).not.toBe(a);
  });
});

describe("extractPage: page content", () => {
  it("extracts title, h1, headings, lang, canonical and robots raw", () => {
    const p = extractPage(
      `<html lang="en-GB"><head><title>  My   Page </title>
        <link rel="alternate canonical" href="../Canonical/?a=1&amp;b=2">
        <meta name="ROBOTS" content="noindex,nofollow"></head>
        <body><h1>Title <em>one</em></h1><h2>Sub</h2><h3>  </h3></body></html>`,
      PAGE,
    );
    expect(p).toMatchObject({
      title: "My Page",
      h1: "Title one",
      headings: [
        { level: 1, text: "Title one" },
        { level: 2, text: "Sub" },
      ],
      lang: "en-GB",
      metaCanonical: "../Canonical/?a=1&b=2",
      metaRobots: "noindex,nofollow",
      nofollow: true,
    });
  });

  it("takes body text and <p>/<li> paragraphs from main content only (about.html, no <main>)", () => {
    const p = fixture("about.html", "http://f.test/about.html");
    expect(p.paragraphs).toEqual([
      "Served for both /about.html and /about.html?ref=nav; the canonical tag is stored raw.",
      "We audit internal links.",
      "We never normalise raw data.",
      "Read the blog.",
    ]);
    expect(p.bodyText).toBe(
      "About us Served for both /about.html and /about.html?ref=nav; the canonical tag is stored raw. We audit internal links. We never normalise raw data. Read the blog.",
    );
    for (const chrome of ["Elsewhere", "Home"]) expect(p.bodyText).not.toContain(chrome);
  });

  it("uses <main> when present and strips chrome inside it (blog/index.html)", () => {
    const p = fixture("blog/index.html", "http://f.test/blog/");
    expect(p.paragraphs).toEqual([
      "Summary of the first post.",
      "Summary of the second post.",
      "Nofollow page",
    ]);
    expect(p.bodyText).toContain("Post one"); // <article><header> is content
    expect(p.bodyText).not.toMatch(/\b1 2\b/); // pagination stripped
    expect(p.bodyText).not.toContain("About"); // menu outside <main>
  });

  it("does not duplicate nested list items or <p> inside <li>", () => {
    const p = extractPage(
      "<main><ul><li>Top<ul><li>Child</li></ul></li><li><p>In p</p></li></ul></main>",
      PAGE,
    );
    expect(p.paragraphs).toEqual(["Top", "Child", "In p"]);
  });

  it("strips script, style and chrome from body text", () => {
    const p = extractPage(
      "<body><header>Site</header><script>var x</script><style>p{}</style><p>Kept</p><footer>©</footer></body>",
      PAGE,
    );
    expect(p.bodyText).toBe("Kept");
  });

  it.each([
    ["noindex,nofollow", true],
    ["NOINDEX, NOFOLLOW", true],
    ["none", true],
    ["index, follow", false],
    ["noindex", false],
    ["nofollowing", false],
  ])("records meta robots %j as nofollow=%s without dropping links", (content, nofollow) => {
    const p = extractPage(`<meta name="robots" content="${content}"><a href="/x">x</a>`, PAGE);
    expect(p.nofollow).toBe(nofollow);
    expect(p.links).toHaveLength(1);
  });

  it("returns nulls and defaults for an empty document", () => {
    expect(extractPage("", PAGE)).toMatchObject({
      title: null,
      h1: null,
      headings: [],
      metaCanonical: null,
      metaRobots: null,
      bodyText: null,
      paragraphs: [],
      lang: null,
      links: [],
      nofollow: false,
    });
  });
});
