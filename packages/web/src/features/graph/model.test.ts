import { describe, expect, it } from "vitest";
import type { GraphResponse, Issue } from "../../api/types.js";
import { fix } from "../../test/utils.js";
import {
  buildElements,
  DEPTH_BANDS,
  depthBand,
  ISSUE_COLOURS,
  nodeDetails,
  nodeSize,
  ORPHAN_CLUSTER,
  primaryIssue,
  regionOf,
  type NodeData,
} from "./model.js";

const S = "https://s.test";
const node = (path: string, pagerank: number, depth: number | null) => ({
  key: S + path,
  attributes: { pagerank, depth, inDegree: 1, outDegree: 1, crawled: true },
});
const edge = (
  from: string,
  to: string,
  domRegion: string | null,
  anchorText: string | null = null,
) => ({
  source: S + from,
  target: S + to,
  attributes: { domRegion, anchorText },
});

const data: GraphResponse = {
  policy: "P3",
  policyVersion: "P3@1.0.0",
  graph: {
    attributes: { nodes: 6, seedNode: `${S}/` },
    nodes: [
      node("/", 0.1, 0),
      node("/a", 0.4, 1),
      node("/b", 0.3, 1),
      node("/c", 0.15, 2),
      node("/deep", 0.02, 7),
      node("/linked-orphan", 0.03, null), // linked only from an unreachable page
    ],
    edges: [
      edge("/", "/a", "nav", "A"),
      edge("/", "/a", "main", "Read about A"), // parallel: main content wins
      edge("/", "/b", "footer"),
      edge("/a", "/c", "main"),
      edge("/b", "/c", "breadcrumb"),
      edge("/c", "/deep", "main"),
      edge("/a", "/a", "main"), // self-loop: dropped
      edge("/linked-orphan", "/b", "main"),
    ],
  },
};
const issue = (
  path: string,
  type: Issue["type"],
  evidence: Record<string, unknown> = {},
): Issue => ({
  id: `${type}:${S}${path}`,
  type,
  node: S + path,
  severity: "medium",
  evidence,
});
const issues: Issue[] = [
  issue("/linked-orphan", "orphan", { channels: ["xml_sitemap"] }),
  issue("/sitemap-only", "orphan", { channels: ["feed"] }), // not in the link graph at all
  issue("/deep", "deep-page", { depth: 7, threshold: 3 }),
  issue("/deep", "dead-end"),
  issue("/c", "weak-authority"),
];
const nodeData = (els: ReturnType<typeof buildElements>, path: string) =>
  els.nodes.find((n) => n.data.id === S + path)?.data as NodeData | undefined;

describe("bands, regions and issue order", () => {
  it("bands depth", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 12, null].map(depthBand)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4-5",
      "4-5",
      "6+",
      "6+",
      "unreachable",
    ]);
    expect(DEPTH_BANDS).toHaveLength(7);
  });

  it("classes dom_region, main and none being main content", () => {
    expect(["main", "body", null, "nav", "footer", "weird"].map(regionOf)).toEqual([
      "body",
      "body",
      "body",
      "nav",
      "footer",
      "body",
    ]);
  });

  it("colours a node by its most important issue", () => {
    expect(primaryIssue([issue("/x", "dead-end"), issue("/x", "deep-page")])).toBe("deep-page");
    expect(primaryIssue([])).toBe("none");
    expect(ISSUE_COLOURS[0]?.type).toBe("orphan");
  });

  it("sizes nodes by PageRank on a square-root scale", () => {
    expect(nodeSize(0, 1)).toBe(16);
    expect(nodeSize(1, 1)).toBe(64);
    expect(nodeSize(0.25, 1)).toBe(40);
  });
});

describe("buildElements", () => {
  const els = buildElements(data, issues, "depth");

  it("puts every orphan in a highlighted cluster, including ones the graph lacks", () => {
    expect(els.nodes[0]).toEqual({
      data: { id: ORPHAN_CLUSTER, label: "Orphans (2)" },
      classes: "cluster",
    });
    expect(nodeData(els, "/linked-orphan")).toMatchObject({
      parent: ORPHAN_CLUSTER,
      orphan: true,
      issue: "orphan",
    });
    expect(nodeData(els, "/sitemap-only")).toMatchObject({
      parent: ORPHAN_CLUSTER,
      band: "unreachable",
      pagerank: 0,
    });
    expect(els.nodes.find((n) => n.data.id === `${S}/sitemap-only`)?.classes).toBe("orphan");
    expect(nodeData(els, "/a")?.parent).toBeUndefined();
    expect(els.nodes.find((n) => n.data.id === `${S}/`)?.classes).toBe("seed");
  });

  it("collapses parallel links, keeps the most prominent region, drops self-loops", () => {
    const toA = els.edges.find((e) => e.data.source === `${S}/` && e.data.target === `${S}/a`);
    expect(toA).toMatchObject({ data: { region: "body", count: 2 }, classes: "region-body" });
    expect(
      els.edges.find((e) => e.data.target === `${S}/b` && e.data.source === `${S}/`)?.classes,
    ).toBe("region-footer");
    expect(els.edges.some((e) => e.data.source === e.data.target)).toBe(false);
    expect(els.stats).toEqual({
      totalNodes: 7,
      shownNodes: 7,
      totalEdges: 6,
      shownEdges: 6,
      orphans: 2,
    });
  });

  it("precomputes both colourings; the mode picks one", () => {
    const deep = nodeData(els, "/deep") as NodeData;
    expect(deep.band).toBe("6+");
    expect(deep.issue).toBe("deep-page");
    expect(deep.colour).toBe(deep.colourDepth);
    const byIssue = nodeData(buildElements(data, issues, "issue"), "/deep") as NodeData;
    expect(byIssue.colour).toBe(byIssue.colourIssue);
    expect(byIssue.colourIssue).not.toBe(byIssue.colourDepth);
  });

  it("caps pages by PageRank, keeps the home page and every orphan, and only links between shown pages", () => {
    const capped = buildElements(data, issues, "depth", { maxNodes: 2, maxEdges: 100 });
    const ids = capped.nodes.map((n) => n.data.id.replace(S, ""));
    // /a (0.4) and the home page (forced in over /b, 0.3); both orphans.
    expect(ids.sort()).toEqual(
      ["/", "/a", "/linked-orphan", "/sitemap-only", ORPHAN_CLUSTER.replace(S, "")].sort(),
    );
    expect(
      capped.edges.map((e) => `${e.data.source.replace(S, "")}→${e.data.target.replace(S, "")}`),
    ).toEqual(["/→/a"]);
    expect(capped.stats).toMatchObject({ shownNodes: 4, totalNodes: 7, shownEdges: 1 });
  });

  it("caps links with main-content links first", () => {
    const capped = buildElements(data, issues, "depth", { maxNodes: 100, maxEdges: 3 });
    expect(capped.edges.every((e) => e.data.region === "body")).toBe(true);
    expect(capped.stats.shownEdges).toBe(3);
  });

  it("has no cluster when there are no orphans", () => {
    const none = buildElements(
      data,
      issues.filter((i) => i.type !== "orphan"),
      "depth",
    );
    expect(none.nodes.some((n) => n.data.id === ORPHAN_CLUSTER)).toBe(false);
    expect(nodeData(none, "/linked-orphan")?.parent).toBeUndefined();
  });
});

describe("nodeDetails", () => {
  const fixes = [
    fix(3, { donor: `${S}/a`, target: `${S}/deep` }),
    fix(1, { donor: `${S}/b`, target: `${S}/deep` }),
    fix(2, { donor: `${S}/a`, target: `${S}/c` }),
  ];

  it("lists inbound links grouped by page, most prominent region first, with anchors", () => {
    const d = nodeDetails(`${S}/a`, data, issues, fixes);
    expect(d.inbound).toEqual([
      { node: `${S}/`, region: "body", count: 2, anchors: ["A", "Read about A"] },
    ]);
    expect(d.outbound.map((r) => r.node)).toEqual([`${S}/c`]);
    expect(d).toMatchObject({ inGraph: true, issues: [] });
  });

  it("gives a page's issues and the fixes that target it, best first", () => {
    const d = nodeDetails(`${S}/deep`, data, issues, fixes);
    expect(d.issues.map((i) => i.type)).toEqual(["deep-page", "dead-end"]);
    expect(d.fixes.map((f) => f.rank)).toEqual([1, 3]);
    expect(d.attributes?.depth).toBe(7);
  });

  it("carries the page type and importance when the graph has them, else null", () => {
    expect(nodeDetails(`${S}/a`, data, issues, fixes).importance).toBeNull();
    const imp = {
      type: "hub" as const,
      rule: "url:hub",
      evidence: "(^|/)category/",
      importance: 0.7,
      components: { typePrior: 0.7, pagerank: 0.8, depth: 0.5, inboundBodyLinks: 1 },
      raw: { pagerank: 0.1, depth: 1, inboundBodyLinks: 3 },
      schemaTypes: [],
    };
    const d = nodeDetails(`${S}/a`, { ...data, importance: { [`${S}/a`]: imp } }, issues, fixes);
    expect(d.importance).toEqual(imp);
  });

  it("handles an orphan that is not in the link graph", () => {
    const d = nodeDetails(`${S}/sitemap-only`, data, issues, fixes);
    expect(d).toMatchObject({ inGraph: false, attributes: null, inbound: [], outbound: [] });
    expect(d.issues[0]?.evidence).toEqual({ channels: ["feed"] });
  });
});
