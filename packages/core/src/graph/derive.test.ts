import { describe, expect, it } from "vitest";
import { buildCanonicalContext, EMPTY_CONTEXT } from "../canonicalise/index.js";
import { makeConfig } from "../config.js";
import { buildLinkGraph, type LinkInput } from "./build.js";
import { deriveGraphFromObservations } from "./derive.js";
import { makeInternalTest } from "./scope.js";
import { mulberry32, sampleWithoutReplacement } from "./random.js";

const S = "https://site.test";
const config = makeConfig();

/** Links as [id, sourceFetchId, resolvedUrl, region?]. */
function links(rows: [number, number, string, string?][]): LinkInput[] {
  return rows.map(([id, sourceFetchId, resolvedUrl, domRegion]) => ({
    id,
    sourceFetchId,
    resolvedUrl,
    domRegion: domRegion ?? "main",
    anchorText: `a${id}`,
    templateSignature: domRegion === "nav" ? "navsig" : null,
    rel: null,
  }));
}

// Home (1) links to /a, /b, itself, an external site and mailto; /a (2) links /b twice and home;
// /b (3) links /a; /a?utm_source=x (4) is a duplicate of /a under P2+ and links /c.
const pages = [
  { fetchId: 1, url: `${S}/` },
  { fetchId: 2, url: `${S}/a` },
  { fetchId: 3, url: `${S}/b` },
  { fetchId: 4, url: `${S}/a?utm_source=x` },
];
const obs = links([
  [10, 1, `${S}/a`, "nav"],
  [11, 1, `${S}/b`, "nav"],
  [12, 1, `${S}/#top`],
  [13, 1, "https://elsewhere.test/"],
  [14, 1, "mailto:hi@site.test"],
  [20, 2, `${S}/b`],
  [21, 2, `${S}/b`],
  [22, 2, `${S}/`],
  [30, 3, `${S}/a`],
  [40, 4, `${S}/c`],
]);

describe("buildLinkGraph", () => {
  const build = (policy: (u: string) => string) =>
    buildLinkGraph({
      seedUrl: `${S}/`,
      pages,
      links: obs,
      isInternal: makeInternalTest(`${S}/`, false),
      canonicalise: policy,
    });

  it("keeps one edge per observation with its attributes, keyed by observation id", () => {
    const { graph } = build((u) => u.split("#")[0] as string);
    expect(graph.hasEdge("obs:10")).toBe(true);
    expect(graph.getEdgeAttributes("obs:10")).toEqual({
      observationId: 10,
      domRegion: "nav",
      anchorText: "a10",
      templateSignature: "navsig",
      rel: null,
    });
    expect(graph.outEdges(`${S}/a`, `${S}/b`).sort()).toEqual(["obs:20", "obs:21"]); // parallel kept
  });

  it("drops self-loops but counts them per node, and leaves out external/non-http links", () => {
    const { graph, stats } = build((u) => u.split("#")[0] as string);
    expect(stats).toMatchObject({ selfLoops: 1, externalLinks: 2 });
    expect(graph.getNodeAttribute(`${S}/`, "selfLoops")).toBe(1);
    expect(graph.hasNode("https://elsewhere.test/")).toBe(false);
  });

  it("without merging, every page is its own node", () => {
    const { graph, stats } = build((u) => u);
    expect(graph.order).toBe(6); // /, /#top, /a, /b, /a?utm…, /c
    expect(stats.duplicatePageLinks).toBe(0);
  });

  it("when a policy merges pages, links come from the earliest page only", () => {
    const stripQuery = (u: string) => u.split(/[?#]/)[0] as string;
    const { graph, stats } = build(stripQuery);
    expect(graph.getNodeAttributes(`${S}/a`)).toMatchObject({
      crawled: true,
      pages: 2,
      representativeFetchId: 2,
    });
    expect(stats.duplicatePageLinks).toBe(1); // /a?utm… → /c not used
    expect(graph.hasNode(`${S}/c`)).toBe(false);
  });

  it("adds uncrawled link targets as nodes", () => {
    const { graph } = build((u) => u);
    expect(graph.getNodeAttributes(`${S}/c`)).toMatchObject({ crawled: false, pages: 0 });
  });

  it("is identical for identical input (sorted nodes, keyed edges)", () => {
    const a = JSON.stringify(build((u) => u).graph.export());
    const b = JSON.stringify(
      buildLinkGraph({
        seedUrl: `${S}/`,
        pages: [...pages].reverse(),
        links: [...obs].reverse(),
        isInternal: makeInternalTest(`${S}/`, false),
        canonicalise: (u) => u,
      }).graph.export(),
    );
    expect(a).toBe(b);
  });
});

describe("deriveGraphFromObservations", () => {
  const derive = (policy: "P0" | "P2" | "P5", ctx = EMPTY_CONTEXT) =>
    deriveGraphFromObservations(
      { runId: 7, seedUrl: `${S}/`, pages, links: obs },
      policy,
      ctx,
      config,
    );

  it("P0: attaches every metric to every node and summarises the graph", () => {
    const { graph, summary } = derive("P0");
    expect(summary).toMatchObject({
      runId: 7,
      policyVersion: "P0@1.0.0",
      seedNode: `${S}/`,
      nodes: 6,
      edges: 8, // incl. /a?utm… → /c: that page is its own node under P0
      selfLoops: 0, // under P0 "/#top" is a different node from "/"
      externalLinks: 2,
      pagerank: { converged: true, damping: 0.85 },
      betweenness: { sampled: false, seed: 42 },
    });
    expect(graph.getNodeAttributes(`${S}/a`)).toMatchObject({
      depth: 1,
      reachable: true,
      inDegree: 2, // from / and /b
      outDegree: 3, // /b twice, /
      inNeighbours: 2,
      outNeighbours: 2,
    });
    expect(graph.getNodeAttributes(`${S}/c`)).toMatchObject({ depth: null, reachable: false });
    const total = graph
      .nodes()
      .reduce((s, n) => s + (graph.getNodeAttribute(n, "pagerank") ?? 0), 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it("P2: merges the tracking-param duplicate and the fragment self-link", () => {
    const { graph, summary } = derive("P2");
    expect(summary).toMatchObject({ nodes: 3, selfLoops: 1, duplicatePageLinks: 1 });
    expect(graph.nodes()).toEqual([`${S}/`, `${S}/a`, `${S}/b`]);
    // /, /a, /b form one SCC: / → a → / and a ↔ b
    for (const n of graph.nodes()) expect(graph.getNodeAttribute(n, "inLargestScc")).toBe(true);
    expect(summary).toMatchObject({ sccCount: 1, largestSccSize: 3, reachable: 3 });
  });

  it("P5: follows the context's canonicals", () => {
    const ctx = buildCanonicalContext(
      { canonicals: [[`${S}/b`, "/a"]], fetchedOk: [`${S}/a`] },
      { maxCanonicalHops: 3 },
    );
    const { graph, summary } = derive("P5", ctx);
    expect(summary.policyVersion).toBe("P5@1.0.0");
    expect(graph.hasNode(`${S}/b`)).toBe(false); // canonicalised into /a
    expect(graph.getNodeAttribute(`${S}/a`, "pages")).toBe(3);
  });

  it("serialises to plain JSON (no undefined or NaN)", () => {
    const json = JSON.stringify(derive("P0").graph.export());
    expect(json).not.toMatch(/NaN|undefined/);
    expect(JSON.parse(json).attributes.policyVersion).toBe("P0@1.0.0");
  });
});

describe("makeInternalTest", () => {
  it("mirrors the crawler's scope", () => {
    const exact = makeInternalTest("https://www.site.test/", false);
    expect(exact("http://www.site.test/x")).toBe(true);
    expect(exact("https://blog.site.test/")).toBe(false);
    expect(exact("mailto:a@www.site.test")).toBe(false);
    expect(exact("http://[bad")).toBe(false);
    const subs = makeInternalTest("https://www.site.test/", true);
    expect(subs("https://blog.site.test/")).toBe(true);
    expect(subs("https://site.test/")).toBe(true);
    expect(subs("https://notsite.test/")).toBe(false);
  });
});

describe("random helpers", () => {
  it("mulberry32 is seeded and in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("samples distinct items", () => {
    const s = sampleWithoutReplacement([...Array(50).keys()], 20, mulberry32(1));
    expect(new Set(s).size).toBe(20);
    expect(sampleWithoutReplacement([1, 2], 5, mulberry32(1))).toHaveLength(2);
  });
});
