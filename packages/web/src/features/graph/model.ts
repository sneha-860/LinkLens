import type {
  Fix,
  GraphNodeAttributes,
  GraphResponse,
  Issue,
  IssueType,
  NodeImportance,
} from "../../api/types.js";
import { shortUrl } from "../../ui/format.js";

// ---------- colours ----------

export type ColourMode = "depth" | "issue";

export const DEPTH_BANDS = [
  { band: "0", label: "Home", colour: "#1f8a4c" },
  { band: "1", label: "1 click", colour: "#3d5afe" },
  { band: "2", label: "2 clicks", colour: "#7c4dff" },
  { band: "3", label: "3 clicks", colour: "#c77800" },
  { band: "4-5", label: "4–5 clicks", colour: "#e0620d" },
  { band: "6+", label: "6+ clicks", colour: "#c0352b" },
  { band: "unreachable", label: "Unreachable", colour: "#9e9e98" },
] as const;
export type DepthBand = (typeof DEPTH_BANDS)[number]["band"];

export function depthBand(depth: number | null | undefined): DepthBand {
  if (depth === null || depth === undefined) return "unreachable";
  if (depth <= 3) return String(depth) as DepthBand;
  return depth <= 5 ? "4-5" : "6+";
}

/** Issue types by how much they matter; a node shows its first. */
export const ISSUE_COLOURS: { type: IssueType | "none"; label: string; colour: string }[] = [
  { type: "orphan", label: "Orphan", colour: "#c0352b" },
  { type: "noindex-nofollow-conflict", label: "noindex/nofollow conflict", colour: "#ad1457" },
  { type: "deep-page", label: "Deep page", colour: "#e0620d" },
  { type: "weak-authority", label: "Weak authority", colour: "#c77800" },
  { type: "dead-end", label: "Dead end", colour: "#7c4dff" },
  { type: "outside-largest-scc", label: "Outside main cluster", colour: "#3d5afe" },
  { type: "none", label: "No issue", colour: "#b8c4b0" },
];

const colourOfDepth = (band: DepthBand) =>
  DEPTH_BANDS.find((b) => b.band === band)?.colour as string;
const colourOfIssue = (type: IssueType | "none") =>
  ISSUE_COLOURS.find((c) => c.type === type)?.colour as string;

export function primaryIssue(issues: readonly Issue[]): IssueType | "none" {
  for (const c of ISSUE_COLOURS) if (issues.some((i) => i.type === c.type)) return c.type;
  return "none";
}

// ---------- edges ----------

/** Link regions from most to least prominent; a collapsed edge takes its most prominent. */
export const REGIONS = [
  { region: "body", label: "Main content" },
  { region: "breadcrumb", label: "Breadcrumb" },
  { region: "aside", label: "Sidebar" },
  { region: "header", label: "Header" },
  { region: "nav", label: "Navigation" },
  { region: "pagination", label: "Pagination" },
  { region: "footer", label: "Footer" },
] as const;
export type Region = (typeof REGIONS)[number]["region"];

/** A stored dom_region as a region class (main, body and none are the main content). */
export function regionOf(domRegion: string | null | undefined): Region {
  if (domRegion === null || domRegion === undefined || domRegion === "main") return "body";
  return (REGIONS.find((r) => r.region === domRegion)?.region ?? "body") as Region;
}
const regionRank = (r: Region) => REGIONS.findIndex((x) => x.region === r);

// ---------- elements ----------

export const ORPHAN_CLUSTER = "cluster:orphans";

export interface GraphLimits {
  /** Link-graph pages drawn at most (highest PageRank first; orphans are always drawn). */
  readonly maxNodes: number;
  /** Links drawn at most (main-content links first). */
  readonly maxEdges: number;
}
export const DEFAULT_LIMITS: GraphLimits = { maxNodes: 300, maxEdges: 1500 };

export interface NodeData {
  id: string;
  label: string;
  parent?: string;
  size: number;
  pagerank: number;
  depth: number | null;
  band: DepthBand;
  issue: IssueType | "none";
  colourDepth: string;
  colourIssue: string;
  colour: string;
  orphan: boolean;
}
export interface EdgeData {
  id: string;
  source: string;
  target: string;
  region: Region;
  /** Link observations collapsed into this edge. */
  count: number;
}
export interface Elements {
  nodes: { data: NodeData | { id: string; label: string }; classes?: string }[];
  edges: { data: EdgeData; classes: string }[];
  stats: {
    totalNodes: number;
    shownNodes: number;
    totalEdges: number;
    shownEdges: number;
    orphans: number;
  };
}

/** Node size from PageRank: 16–64 px on a square-root scale. */
export const nodeSize = (pr: number, maxPr: number) =>
  16 + 48 * Math.sqrt(pr / Math.max(maxPr, Number.EPSILON));

/**
 * Cytoscape elements for a graph: the top `maxNodes` pages by PageRank (the home page always),
 * every orphan inside a highlighted "Orphans" cluster (added when the link graph lacks it),
 * parallel links collapsed into one edge per pair with its most prominent region, at most
 * `maxEdges` of them (main content first). Both colourings are precomputed so the toggle does
 * not need a new layout.
 */
export function buildElements(
  data: GraphResponse,
  issues: readonly Issue[],
  mode: ColourMode,
  limits: GraphLimits = DEFAULT_LIMITS,
): Elements {
  const issuesOf = new Map<string, Issue[]>();
  for (const i of issues) issuesOf.set(i.node, [...(issuesOf.get(i.node) ?? []), i]);
  const orphans = new Set(issues.filter((i) => i.type === "orphan").map((i) => i.node));
  const attrs = new Map(data.graph.nodes.map((n) => [n.key, n.attributes]));
  const seed = data.graph.attributes.seedNode;

  const ranked = data.graph.nodes
    .filter((n) => !orphans.has(n.key))
    .sort(
      (a, b) =>
        (b.attributes.pagerank ?? 0) - (a.attributes.pagerank ?? 0) || (a.key < b.key ? -1 : 1),
    );
  const kept = ranked.slice(0, limits.maxNodes).map((n) => n.key);
  if (seed !== undefined && attrs.has(seed) && !orphans.has(seed) && !kept.includes(seed)) {
    kept[kept.length - 1] = seed;
  }
  const shown = new Set([...kept, ...orphans]);
  const maxPr = Math.max(
    ...data.graph.nodes.map((n) => n.attributes.pagerank ?? 0),
    Number.EPSILON,
  );

  const node = (
    id: string,
    a: GraphNodeAttributes | undefined,
  ): { data: NodeData; classes?: string } => {
    const band = depthBand(a?.depth);
    const issue = primaryIssue(issuesOf.get(id) ?? []);
    const orphan = orphans.has(id);
    const d: NodeData = {
      id,
      label: shortUrl(id),
      size: nodeSize(a?.pagerank ?? 0, maxPr),
      pagerank: a?.pagerank ?? 0,
      depth: a?.depth ?? null,
      band,
      issue,
      colourDepth: colourOfDepth(band),
      colourIssue: colourOfIssue(issue),
      colour: mode === "depth" ? colourOfDepth(band) : colourOfIssue(issue),
      orphan,
      ...(orphan ? { parent: ORPHAN_CLUSTER } : {}),
    };
    return {
      data: d,
      ...(orphan ? { classes: "orphan" } : id === seed ? { classes: "seed" } : {}),
    };
  };

  const nodes: Elements["nodes"] = [...kept, ...[...orphans].sort()].map((id) =>
    node(id, attrs.get(id)),
  );
  if (orphans.size > 0) {
    nodes.unshift({
      data: { id: ORPHAN_CLUSTER, label: `Orphans (${orphans.size})` },
      classes: "cluster",
    });
  }

  const pairs = new Map<string, EdgeData>();
  for (const e of data.graph.edges) {
    if (e.source === e.target) continue;
    const key = `${e.source}\u0000${e.target}`;
    const region = regionOf(e.attributes?.domRegion);
    const p = pairs.get(key);
    if (p === undefined) {
      pairs.set(key, {
        id: `e:${pairs.size}`,
        source: e.source,
        target: e.target,
        region,
        count: 1,
      });
    } else {
      p.count += 1;
      if (regionRank(region) < regionRank(p.region)) p.region = region;
    }
  }
  const pr = (id: string) => attrs.get(id)?.pagerank ?? 0;
  const visible = [...pairs.values()]
    .filter((e) => shown.has(e.source) && shown.has(e.target))
    .sort(
      (a, b) =>
        regionRank(a.region) - regionRank(b.region) ||
        pr(b.source) - pr(a.source) ||
        (a.id < b.id ? -1 : 1),
    );
  const edges = visible
    .slice(0, limits.maxEdges)
    .map((d) => ({ data: d, classes: `region-${d.region}` }));

  return {
    nodes,
    edges,
    stats: {
      totalNodes: data.graph.nodes.length + [...orphans].filter((o) => !attrs.has(o)).length,
      shownNodes: shown.size,
      totalEdges: pairs.size,
      shownEdges: edges.length,
      orphans: orphans.size,
    },
  };
}

// ---------- side panel ----------

export interface LinkRow {
  node: string;
  region: Region;
  count: number;
  anchors: string[];
}
export interface NodeDetails {
  node: string;
  attributes: GraphNodeAttributes | null;
  inGraph: boolean;
  issues: Issue[];
  inbound: LinkRow[];
  outbound: LinkRow[];
  /** Fixes whose target is this node (best first). */
  fixes: Fix[];
  /** Page type and importance (L12), or null when not available. */
  importance: NodeImportance | null;
}

function linkRows(
  rows: { node: string; region: string | null | undefined; anchor: string | null | undefined }[],
) {
  const by = new Map<string, LinkRow>();
  for (const r of rows) {
    const region = regionOf(r.region);
    const row = by.get(r.node) ?? { node: r.node, region, count: 0, anchors: [] };
    row.count += 1;
    if (regionRank(region) < regionRank(row.region)) row.region = region;
    const a = r.anchor?.trim();
    if (a && !row.anchors.includes(a)) row.anchors.push(a);
    by.set(r.node, row);
  }
  return [...by.values()].sort(
    (a, b) =>
      regionRank(a.region) - regionRank(b.region) ||
      b.count - a.count ||
      (a.node < b.node ? -1 : 1),
  );
}

/** Everything the side panel shows for one node. */
export function nodeDetails(
  node: string,
  data: GraphResponse,
  issues: readonly Issue[],
  fixes: readonly Fix[],
): NodeDetails {
  const n = data.graph.nodes.find((x) => x.key === node);
  const edges = data.graph.edges.filter((e) => e.source !== e.target);
  return {
    node,
    attributes: n?.attributes ?? null,
    inGraph: n !== undefined,
    issues: issues.filter((i) => i.node === node),
    importance: data.importance?.[node] ?? null,
    inbound: linkRows(
      edges
        .filter((e) => e.target === node)
        .map((e) => ({
          node: e.source,
          region: e.attributes?.domRegion,
          anchor: e.attributes?.anchorText,
        })),
    ),
    outbound: linkRows(
      edges
        .filter((e) => e.source === node)
        .map((e) => ({
          node: e.target,
          region: e.attributes?.domRegion,
          anchor: e.attributes?.anchorText,
        })),
    ),
    fixes: fixes.filter((f) => f.target === node).sort((a, b) => a.rank - b.rank),
  };
}
