import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultConfig, importance } from "@linklens/core";
import { extractPage } from "./extract.js";

/**
 * The page-type classifier (core importance, L12) on real HTML: each fixture page goes through
 * the crawler's own extraction, and its signals are built as the pipeline builds them (text,
 * schema.org types, internal main-content links, pagination).
 */
const SITE = fileURLToPath(new URL("../test/fixtures/site/", import.meta.url));
const TYPES = fileURLToPath(new URL("../test/fixtures/page-types/", import.meta.url));
const ORIGIN = "https://shop.test";
const rules = importance.compileRules(defaultConfig.pageTypeRules);

function classify(file: string, url: string, isSeed = false) {
  const html = readFileSync(file, "utf8");
  const page = extractPage(html, url);
  const host = new URL(url).host;
  const internal = page.links.filter(
    (l) => URL.canParse(l.resolvedUrl) && new URL(l.resolvedUrl).host === host,
  );
  const signals = importance.pageSignals({
    url,
    isSeed,
    crawled: true,
    bodyText: page.bodyText,
    schemaTypes: importance.schemaTypes(html),
    links: internal,
  });
  return { ...importance.classifyPage(signals, rules), signals };
}

describe("page types of the fixture pages", () => {
  const cases: [file: string, path: string, type: string, rule: string][] = [
    // The schema.org type of the page decides, although the URL looks like a hub.
    ["product.html", "/collections/red-mug", "product", "schema:Product"],
    // A listing whose ItemList holds Products is a hub: nested items are not the page's type.
    ["category.html", "/shop/mugs", "hub", "schema:ItemList"],
    ["login.html", "/account/login", "utility", "url:utility"],
    ["search.html", "/results", "utility", "schema:SearchResultsPage"],
    ["tag.html", "/tag/ceramics/", "utility", "url:utility"],
    // Microdata: a top-level TechArticle (its author, an itemprop Person, does not count).
    ["docs.html", "/help/cleaning", "article", "schema:TechArticle"],
    // Nothing but structure: long text with few links, and a page that is mostly links.
    ["history.html", "/our-history", "article", "structure:article"],
    ["all-mugs.html", "/every-mug", "hub", "structure:hub"],
    ["contact.html", "/contact", "other", "default"],
  ];
  for (const [file, path, type, rule] of cases) {
    it(`${file} at ${path} is ${type} (${rule})`, () => {
      expect(classify(TYPES + file, ORIGIN + path)).toMatchObject({ type, rule });
    });
  }

  it("reads the schema.org types each page declares about itself", () => {
    const html = (f: string) => readFileSync(TYPES + f, "utf8");
    expect(importance.schemaTypes(html("product.html"))).toEqual(["Product"]);
    expect(importance.schemaTypes(html("category.html"))).toEqual(["ItemList"]);
    expect(importance.schemaTypes(html("docs.html"))).toEqual(["TechArticle"]);
    expect(importance.schemaTypes(html("contact.html"))).toEqual([]);
  });

  it("measures structure from the main content only (navigation and footer links excluded)", () => {
    const hub = classify(TYPES + "all-mugs.html", `${ORIGIN}/every-mug`).signals;
    expect(hub.bodyLinks).toBe(25);
    const article = classify(TYPES + "history.html", `${ORIGIN}/our-history`).signals;
    expect(article.bodyLinks).toBe(1);
    expect(article.bodyWords).toBeGreaterThanOrEqual(
      defaultConfig.pageTypeRules.structure.articleMinWords,
    );
  });
});

describe("page types of the crawler's fixture site", () => {
  const O = "http://127.0.0.1:8080";
  it("types the homepage, the blog index, a post and the about page", () => {
    expect(classify(SITE + "index.html", `${O}/`, true)).toMatchObject({
      type: "homepage",
      rule: "seed",
    });
    expect(classify(SITE + "blog/index.html", `${O}/blog/`)).toMatchObject({
      type: "hub",
      rule: "url:hub",
    });
    expect(classify(SITE + "blog/post-1.html", `${O}/blog/post-1.html`)).toMatchObject({
      type: "article",
      rule: "url:article",
    });
    // A short page with no pattern and no schema: unclassified. BreadcrumbList (on posts) is
    // ignored as a page type.
    expect(classify(SITE + "about.html", `${O}/about.html`).type).toBe("other");
    expect(importance.schemaTypes(readFileSync(SITE + "blog/post-1.html", "utf8"))).toEqual([]);
  });
});
