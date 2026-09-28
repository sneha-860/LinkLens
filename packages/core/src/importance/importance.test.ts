import { describe, expect, it } from "vitest";
import { EMPTY_CONTEXT } from "../canonicalise/context.js";
import { defaultConfig, makeConfig } from "../config.js";
import { deriveGraphFromObservations } from "../graph/derive.js";
import { computeImportance, percentiles } from "./importance.js";
import { classifyPage, compileRules, pathAndQuery, type PageSignals } from "./page-type.js";
import { schemaTypes } from "./schema.js";

const S = "https://shop.test";
const rules = compileRules(defaultConfig.pageTypeRules);
const signals = (url: string, over: Partial<PageSignals> = {}): PageSignals => ({
  url: S + url,
  isSeed: false,
  schemaTypes: [],
  crawled: true,
  bodyWords: 100,
  bodyLinks: 2,
  bodyLinkWords: 4,
  pagination: false,
  ...over,
});
const typeOf = (url: string, over: Partial<PageSignals> = {}) =>
  classifyPage(signals(url, over), rules);

describe("schemaTypes", () => {
  it("reads page-level JSON-LD types, @graph members and a WebPage's main entity", () => {
    const html = `
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Mug",
        "offers":{"@type":"Offer","price":"9"},"brand":{"@type":"Organization"}}</script>
      <script type='application/ld+json'>{"@graph":[{"@type":"WebSite"},{"@type":["WebPage"],
        "mainEntity":{"@type":"https://schema.org/TechArticle"}}]}</script>
      <script type="application/ld+json">{ not json }</script>`;
    // Offer is nested inside the Product (not the page's type); WebSite and WebPage say nothing.
    expect(schemaTypes(html)).toEqual(["Product", "TechArticle"]);
  });

  it("does not count nested items: a listing of products is not a product page", () => {
    const html = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","item":{"@type":"Product","name":"Mug"}}]}</script>`;
    expect(schemaTypes(html)).toEqual(["ItemList"]);
  });

  it("reads top-level microdata itemtypes, not item properties or breadcrumbs", () => {
    const html = `
      <ol itemscope itemtype="https://schema.org/BreadcrumbList"><li>x</li></ol>
      <div itemscope itemtype="http://schema.org/Recipe">
        <span itemprop="author" itemscope itemtype="https://schema.org/Person">Ana</span>
        <div itemprop="review" itemscope itemtype='https://schema.org/Review'></div>
      </div>`;
    expect(schemaTypes(html)).toEqual(["Recipe"]);
    expect(schemaTypes("<p>nothing</p>")).toEqual([]);
  });
});

describe("classifyPage", () => {
  it("names the seed the homepage whatever else it has", () => {
    expect(typeOf("/", { isSeed: true, schemaTypes: ["Product"] })).toMatchObject({
      type: "homepage",
      rule: "seed",
    });
  });

  it("finds utility pages by URL (login, cart, account, search, tags) or schema", () => {
    for (const u of [
      "/login",
      "/cart",
      "/my-account/orders",
      "/search?q=mug",
      "/tag/red/",
      "/index.php?route=account/login",
    ]) {
      expect(typeOf(u).type, u).toBe("utility");
    }
    expect(typeOf("/results", { schemaTypes: ["SearchResultsPage"] })).toMatchObject({
      type: "utility",
      rule: "schema:SearchResultsPage",
    });
  });

  it("prefers schema.org types to URL patterns: product, then article, then hub", () => {
    expect(typeOf("/blog/mugs", { schemaTypes: ["Product"] })).toMatchObject({
      type: "product",
      rule: "schema:Product",
    });
    expect(typeOf("/category/news", { schemaTypes: ["NewsArticle"] }).type).toBe("article");
    expect(typeOf("/x", { schemaTypes: ["CollectionPage", "BlogPosting"] }).type).toBe("article");
    expect(typeOf("/x", { schemaTypes: ["ItemList"] })).toMatchObject({
      type: "hub",
      rule: "schema:ItemList",
    });
  });

  it("falls back to URL patterns: product, hub (before article), article", () => {
    expect(typeOf("/products/blue-mug")).toMatchObject({ type: "product", rule: "url:product" });
    expect(typeOf("/index.php?route=product/product&product_id=40").type).toBe("product");
    expect(typeOf("/category/mugs").type).toBe("hub");
    expect(typeOf("/blog/page/2").type).toBe("hub");
    expect(typeOf("/blog/").type).toBe("hub");
    expect(typeOf("/blog/how-to-choose-a-mug").type).toBe("article");
    expect(typeOf("/2024/05/launch").type).toBe("article");
    expect(typeOf("/docs/getting-started").type).toBe("article");
  });

  it("uses structure when nothing else matches, and only for crawled pages", () => {
    const hub = { bodyLinks: 40, bodyLinkWords: 120, bodyWords: 200 };
    expect(typeOf("/mugs", hub)).toMatchObject({ type: "hub", rule: "structure:hub" });
    expect(typeOf("/mugs", { bodyLinks: 6, pagination: true }).type).toBe("hub");
    const article = { bodyWords: 900, bodyLinks: 5, bodyLinkWords: 12 };
    expect(typeOf("/about-our-mugs", article)).toMatchObject({
      type: "article",
      rule: "structure:article",
    });
    expect(typeOf("/about-our-mugs", { ...article, crawled: false })).toMatchObject({
      type: "other",
      rule: "default",
    });
    expect(typeOf("/about")).toMatchObject({ type: "other" });
  });

  it("matches the path and query only", () => {
    expect(pathAndQuery(`${S}/a/b?x=1#frag`)).toBe("/a/b?x=1");
    expect(pathAndQuery(S)).toBe("/");
  });
});

describe("computeImportance", () => {
  // Home → category → two products; home → blog post; login linked from the footer everywhere.
  const pages = [
    "/",
    "/category/mugs",
    "/products/red",
    "/products/blue",
    "/blog/story",
    "/login",
  ].map((p, i) => ({ fetchId: i + 1, url: S + p }));
  let id = 0;
  const link = (from: number, to: string, region = "main") => ({
    id: ++id,
    sourceFetchId: from,
    resolvedUrl: S + to,
    domRegion: region,
    anchorText: "link text",
    templateSignature: null,
    rel: null,
  });
  const links = [
    link(1, "/category/mugs"),
    link(1, "/blog/story"),
    link(2, "/products/red"),
    link(2, "/products/blue"),
    link(5, "/products/red"),
    ...[1, 2, 3, 4, 5].map((f) => link(f, "/login", "footer")),
  ];
  const config = makeConfig();
  const { graph, summary } = deriveGraphFromObservations(
    { runId: 1, seedUrl: `${S}/`, pages, links },
    "P0",
    EMPTY_CONTEXT,
    config,
  );
  const result = computeImportance(
    {
      runId: 1,
      policyVersion: "P0@1.0.0",
      graph,
      seedNode: summary.seedNode,
      bodyText: () => "some words here",
      schemaTypes: () => [],
    },
    config,
  );
  const of = (p: string) => result.nodes[S + p] ?? result.nodes[`${S}${p}/`];

  it("types every node and keeps importance in [0, 1]", () => {
    expect(Object.keys(result.nodes)).toHaveLength(6);
    expect(of("/")?.type).toBe("homepage");
    expect(of("/category/mugs")?.type).toBe("hub");
    expect(of("/products/red")?.type).toBe("product");
    expect(of("/blog/story")?.type).toBe("article");
    expect(of("/login")?.type).toBe("utility");
    expect(result.counts).toMatchObject({
      homepage: 1,
      hub: 1,
      product: 2,
      article: 1,
      utility: 1,
      other: 0,
    });
    for (const n of Object.values(result.nodes)) {
      expect(n.importance).toBeGreaterThanOrEqual(0);
      expect(n.importance).toBeLessThanOrEqual(1);
    }
  });

  it("combines the components with the configured weights", () => {
    const red = of("/products/red");
    const w = config.importanceWeights;
    const c = red?.components;
    expect(c?.typePrior).toBe(config.pageTypePriors.product);
    expect(c?.depth).toBeCloseTo(1 / (1 + 2), 12);
    // Two body links in; the most any page gets in the body is two.
    expect(red?.raw.inboundBodyLinks).toBe(2);
    expect(c?.inboundBodyLinks).toBe(1);
    const expected =
      (w.typePrior * (c?.typePrior ?? 0) +
        w.pagerank * (c?.pagerank ?? 0) +
        w.depth * (c?.depth ?? 0) +
        w.inboundBodyLinks * (c?.inboundBodyLinks ?? 0)) /
      (w.typePrior + w.pagerank + w.depth + w.inboundBodyLinks);
    expect(red?.importance).toBeCloseTo(expected, 12);
    // Footer links do not count as inbound body links, and a utility page ranks low.
    expect(of("/login")?.raw.inboundBodyLinks).toBe(0);
    expect(of("/login")?.importance as number).toBeLessThan(
      of("/products/red")?.importance as number,
    );
    // The homepage is depth 0; nothing links back to it here, so PageRank does not lift it.
    expect(of("/")?.components.depth).toBe(1);
  });

  it("is deterministic", () => {
    const again = computeImportance(
      {
        runId: 1,
        policyVersion: "P0@1.0.0",
        graph,
        seedNode: summary.seedNode,
        bodyText: () => "some words here",
        schemaTypes: () => [],
      },
      config,
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });
});

describe("percentiles", () => {
  it("gives tied values the same mid-rank percentile", () => {
    expect(percentiles([1, 2, 2, 3])).toEqual([0.125, 0.5, 0.5, 0.875]);
    expect(percentiles([5])).toEqual([0.5]);
  });
});

describe("config", () => {
  it("rejects bad rules, priors, weights and scoring modes", () => {
    const bad = [
      {
        pageTypeRules: {
          ...defaultConfig.pageTypeRules,
          product: { url: ["(unclosed"], schema: [] },
        },
      },
      { pageTypePriors: { ...defaultConfig.pageTypePriors, hub: 1.5 } },
      { importanceWeights: { typePrior: 0, pagerank: 0, depth: 0, inboundBodyLinks: 0 } },
      { importanceWeights: { ...defaultConfig.importanceWeights, depth: -1 } },
      { fixScoring: "S2" as never },
    ];
    for (const b of bad) expect(() => makeConfig(b)).toThrow(RangeError);
    expect(makeConfig({ fixScoring: "S_imp" }).fixScoring).toBe("S_imp");
  });
});
