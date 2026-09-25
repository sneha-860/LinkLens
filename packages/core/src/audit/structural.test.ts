import { describe, expect, it } from "vitest";
import { EMPTY_CONTEXT, p0 } from "../canonicalise/index.js";
import { makeConfig } from "../config.js";
import { reconcile, type ObservationInput } from "../discovery/reconcile.js";
import type { LinkInput } from "../graph/build.js";
import { deriveGraphFromObservations } from "../graph/derive.js";
import { makeInternalTest } from "../graph/scope.js";
import { auditStructure, isNofollow, isNoindex, percentile, type PageFacts } from "./structural.js";

const S = "https://site.test";
const config = makeConfig({ auditDeepPageDepth: 3, auditDeepPageHighDepth: 4 });

// fetchId, path, links (path or [path, rel]), meta robots, canonical, X-Robots-Tag
type P = [
  number,
  string,
  (string | [string, string])[],
  (string | undefined)?,
  (string | undefined)?,
  (string | undefined)?,
];
const site: P[] = [
  [1, "/", ["/a", "/b", ["/nf", "nofollow"], "/d1", "/canon", "/xr"]],
  [2, "/a", ["/", "/b", "/mnf"]],
  [3, "/b", ["/a"]],
  [4, "/d1", ["/d2"]],
  [5, "/d2", ["/d3"]],
  [6, "/d3", ["/d4"]],
  [7, "/d4", ["/d5"]], // depth 4: deep (medium)
  [8, "/d5", []], // depth 5: deep (high), dead end
  [9, "/nf", ["/"]], // linked only with rel=nofollow
  [10, "/mnf", ["/stranded", "/"], "noindex, nofollow"], // sole path to /stranded
  [11, "/stranded", ["/"]],
  [12, "/canon", ["/"], undefined, "/noidx"], // canonical → noindex page
  [13, "/noidx", ["/"], "noindex"], // in a sitemap
  [14, "/xr", ["/"], undefined, undefined, "noindex"], // noindex via header, in a sitemap
];

const pages: PageFacts[] = site.map(([fetchId, path, , metaRobots, canonical, xr]) => ({
  fetchId,
  url: S + path,
  metaRobots: metaRobots ?? null,
  metaCanonical: canonical ?? null,
  xRobotsTag: xr ?? null,
}));
let id = 0;
const links: LinkInput[] = site.flatMap(([fetchId, , ls]) =>
  ls.map((l) => {
    const [path, rel] = typeof l === "string" ? [l, null] : l;
    return {
      id: ++id,
      sourceFetchId: fetchId,
      resolvedUrl: S + path,
      domRegion: "main",
      anchorText: null,
      templateSignature: null,
      rel,
    };
  }),
);
// /noidx is only reached through the canonical page's declaration, not a link: add one so it is crawled & reachable.
links.push({
  id: ++id,
  sourceFetchId: 12,
  resolvedUrl: `${S}/noidx`,
  domRegion: "main",
  anchorText: null,
  templateSignature: null,
  rel: null,
});

const canonicalise = (u: string) => p0(u, EMPTY_CONTEXT);
const { graph } = deriveGraphFromObservations(
  { runId: 1, seedUrl: `${S}/`, pages, links },
  "P0",
  EMPTY_CONTEXT,
  config,
);

const discovered: ObservationInput[] = [
  { channel: "xml_sitemap", url: `${S}/noidx`, sourceDocument: `${S}/sitemap.xml`, detail: {} },
  { channel: "robots_sitemap", url: `${S}/xr`, sourceDocument: `${S}/sm/index.xml`, detail: {} },
  { channel: "xml_sitemap", url: `${S}/orphan-sm`, sourceDocument: `${S}/sitemap.xml`, detail: {} },
  { channel: "feed", url: `${S}/orphan-feed`, sourceDocument: `${S}/feed.xml`, detail: {} },
  { channel: "xml_sitemap", url: `${S}/a`, sourceDocument: `${S}/sitemap.xml`, detail: {} },
];
const reach = new Map<string, { reachable: boolean; depth: number | null }>();
graph.forEachNode((n, a) =>
  reach.set(n, { reachable: a.reachable === true, depth: a.depth ?? null }),
);
const reconciliation = reconcile({
  runId: 1,
  policyVersion: "P0@1.0.0",
  observations: discovered,
  isInternal: makeInternalTest(`${S}/`, false),
  canonicalise,
  graph: reach,
});

const audit = auditStructure({
  runId: 1,
  policyVersion: "P0@1.0.0",
  graph,
  reconciliation,
  pages,
  canonicalise,
  config,
});
const of = (type: string, rule?: string) =>
  audit.issues.filter((i) => i.type === type && (rule === undefined || i.rule === rule));
const nodes = (type: string, rule?: string) => of(type, rule).map((i) => i.node.replace(S, ""));

describe("auditStructure rules", () => {
  it("orphan: reconciled orphans with channel attribution; sitemap-listed ones are high", () => {
    expect(of("orphan")).toEqual([
      {
        id: `orphan:${S}/orphan-sm`,
        type: "orphan",
        node: `${S}/orphan-sm`,
        severity: "high",
        evidence: {
          channels: ["xml_sitemap"],
          sources: { xml_sitemap: [`${S}/sitemap.xml`] },
          inGraph: false,
        },
        policyVersion: "P0@1.0.0",
      },
      {
        id: `orphan:${S}/orphan-feed`,
        type: "orphan",
        node: `${S}/orphan-feed`,
        severity: "medium",
        evidence: { channels: ["feed"], sources: { feed: [`${S}/feed.xml`] }, inGraph: false },
        policyVersion: "P0@1.0.0",
      },
    ]);
  });

  it("deep-page: depth > threshold, high beyond the high threshold", () => {
    expect(of("deep-page").map((i) => [i.node.replace(S, ""), i.severity, i.evidence])).toEqual([
      ["/d5", "high", { depth: 5, threshold: 3 }],
      ["/d4", "medium", { depth: 4, threshold: 3 }],
    ]);
  });

  it("weak-authority: PageRank below the configured percentile of crawled pages", () => {
    const prs = graph
      .filterNodes((_n, a) => a.crawled)
      .map((n) => graph.getNodeAttribute(n, "pagerank") ?? 0);
    const threshold = percentile(prs, 20) as number;
    const high = percentile(prs, 5) as number;
    expect(audit.summary.thresholds).toMatchObject({
      weakAuthorityPercentile: 20,
      weakAuthorityThreshold: threshold,
      weakAuthorityHighThreshold: high,
    });
    const flagged = of("weak-authority");
    expect(flagged.length).toBeGreaterThan(0);
    const expected = graph
      .filterNodes((_n, a) => a.crawled && (a.pagerank ?? 0) < threshold)
      .sort();
    expect(flagged.map((i) => i.node).sort()).toEqual(expected);
    for (const i of flagged) {
      expect(i.severity).toBe((i.evidence["pagerank"] as number) < high ? "high" : "medium");
    }
  });

  it("outside-largest-scc: reachable crawled pages that cannot get back into the core", () => {
    // The core SCC is / ↔ a ↔ b plus every page linking back to "/"; the d-chain never does.
    expect(nodes("outside-largest-scc").sort()).toEqual(["/d1", "/d2", "/d3", "/d4", "/d5"]);
    expect(of("outside-largest-scc").every((i) => i.severity === "low")).toBe(true);
  });

  it("dead-end: crawled pages with no internal out-links", () => {
    expect(nodes("dead-end")).toEqual(["/d5"]);
    expect(of("dead-end")[0]?.evidence).toEqual({ outDegree: 0, inDegree: 1 });
  });

  it("noindex-in-sitemap: via meta robots and via X-Robots-Tag, with the sitemap documents", () => {
    expect(
      of("noindex-nofollow-conflict", "noindex-in-sitemap").map((i) => [
        i.node.replace(S, ""),
        i.severity,
        i.evidence,
      ]),
    ).toEqual([
      [
        "/noidx",
        "high",
        {
          metaRobots: "noindex",
          xRobotsTag: null,
          channels: ["xml_sitemap"],
          sitemaps: [`${S}/sitemap.xml`],
        },
      ],
      [
        "/xr",
        "high",
        {
          metaRobots: null,
          xRobotsTag: "noindex",
          channels: ["robots_sitemap"],
          sitemaps: [`${S}/sm/index.xml`],
        },
      ],
    ]);
  });

  it("canonical-to-noindex: a canonical pointing at a noindex page", () => {
    expect(of("noindex-nofollow-conflict", "canonical-to-noindex")).toMatchObject([
      {
        node: `${S}/canon`,
        severity: "high",
        evidence: { canonical: "/noidx", targetNode: `${S}/noidx`, targetMetaRobots: "noindex" },
      },
    ]);
  });

  it("nofollow-sole-path: a meta-nofollow page that is the only way to reach another page", () => {
    expect(of("noindex-nofollow-conflict", "nofollow-sole-path")).toMatchObject([
      { node: `${S}/mnf`, severity: "medium", evidence: { strandedTargets: [`${S}/stranded`] } },
    ]);
  });

  it("internal-nofollow: counts rel=nofollow links into a page and where they come from", () => {
    expect(of("noindex-nofollow-conflict", "internal-nofollow")).toMatchObject([
      { node: `${S}/nf`, severity: "low", evidence: { nofollowLinks: 1, fromNodes: [`${S}/`] } },
    ]);
  });
});

describe("audit summary and records", () => {
  it("every issue carries type, node, severity, evidence, policy version and a stable id", () => {
    for (const i of audit.issues) {
      expect(i.policyVersion).toBe("P0@1.0.0");
      expect(["high", "medium", "low"]).toContain(i.severity);
      expect(i.id).toBe(
        i.rule === undefined ? `${i.type}:${i.node}` : `${i.type}:${i.rule}:${i.node}`,
      );
    }
    expect(new Set(audit.issues.map((i) => i.id)).size).toBe(audit.issues.length);
  });

  it("counts per type, severity and rule add up", () => {
    const s = audit.summary;
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    expect(sum(s.byType)).toBe(s.total);
    expect(sum(s.bySeverity)).toBe(s.total);
    expect(sum(s.byRule)).toBe(s.byType["noindex-nofollow-conflict"]);
    expect(s).toMatchObject({
      runId: 1,
      policyVersion: "P0@1.0.0",
      total: audit.issues.length,
      pagesAudited: 14,
      byType: {
        orphan: 2,
        "deep-page": 2,
        "outside-largest-scc": 5,
        "dead-end": 1,
        "noindex-nofollow-conflict": 5,
      },
      byRule: {
        "noindex-in-sitemap": 2,
        "canonical-to-noindex": 1,
        "nofollow-sole-path": 1,
        "internal-nofollow": 1,
      },
      thresholds: { deepPageDepth: 3, deepPageHighDepth: 4 },
    });
    expect(s.nodesWithIssues).toBe(new Set(audit.issues.map((i) => i.node)).size);
  });

  it("orders issues by severity, then type, rule and node", () => {
    const rank = { high: 0, medium: 1, low: 2 };
    const sev = audit.issues.map((i) => rank[i.severity]);
    expect(sev).toEqual([...sev].sort((a, b) => a - b));
  });

  it("is deterministic and JSON-safe", () => {
    const again = auditStructure({
      runId: 1,
      policyVersion: "P0@1.0.0",
      graph,
      reconciliation,
      pages: [...pages].reverse(),
      canonicalise,
      config,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(audit));
    expect(JSON.stringify(audit)).not.toMatch(/NaN|undefined/);
  });

  it("works without a reconciliation (no discovery run): no orphans, no sitemap conflicts", () => {
    const a = auditStructure({
      runId: 1,
      policyVersion: "P0@1.0.0",
      graph,
      reconciliation: null,
      pages,
      canonicalise,
      config,
    });
    expect(a.summary.byType.orphan).toBe(0);
    expect(a.summary.byRule["noindex-in-sitemap"]).toBe(0);
    expect(a.summary.byRule["canonical-to-noindex"]).toBe(1);
  });
});

describe("helpers", () => {
  it.each([
    [[], 50, null],
    [[5], 20, 5],
    [[1, 2, 3, 4], 0, 1],
    [[1, 2, 3, 4], 100, 4],
    [[1, 2, 3, 4], 50, 2.5],
    [[4, 1, 3, 2], 25, 1.75],
    [[10, 20, 30, 40, 50], 20, 18],
  ])("percentile(%j, %d) = %s (linear interpolation)", (xs, p, expected) => {
    expect(percentile(xs, p)).toBe(expected);
  });

  it.each([
    ["noindex", null, true, false],
    ["NOINDEX,NOFOLLOW", null, true, true],
    ["none", null, true, true],
    [null, "noindex", true, false],
    ["index, follow", "nofollow", false, true],
    ["noindexing", null, false, false],
    [null, null, false, false],
  ])(
    "meta %j + header %j → noindex=%s nofollow=%s",
    (metaRobots, xRobotsTag, noindex, nofollow) => {
      expect(isNoindex({ metaRobots, xRobotsTag })).toBe(noindex);
      expect(isNofollow({ metaRobots, xRobotsTag })).toBe(nofollow);
    },
  );
});
