import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { GraphNodeAttributes, GraphResponse } from "../../api/types.js";
import { depthColour } from "./colours.js";

export interface DrawNode extends GraphNodeAttributes {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
}

/** Deterministic pseudo-random start positions (the same graph always looks the same). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A drawable graph from the API's graphology export: parallel links collapsed into one edge
 * (sized by their count), nodes sized by PageRank and coloured by depth, laid out by ForceAtlas2.
 */
export function buildDrawGraph(data: GraphResponse): Graph<DrawNode> {
  const g = new Graph<DrawNode>({ type: "directed", multi: false });
  const random = seeded(42);
  const prs = data.graph.nodes.map((n) => n.attributes.pagerank ?? 0);
  const maxPr = Math.max(...prs, Number.EPSILON);
  for (const n of data.graph.nodes) {
    const pr = n.attributes.pagerank ?? 0;
    g.addNode(n.key, {
      ...n.attributes,
      x: random(),
      y: random(),
      size: 3 + 12 * Math.sqrt(pr / maxPr),
      color: depthColour(n.attributes.depth),
      label: n.key,
    });
  }
  for (const e of data.graph.edges) {
    if (e.source === e.target || !g.hasNode(e.source) || !g.hasNode(e.target)) continue;
    const existing = g.edge(e.source, e.target);
    if (existing === undefined) g.addEdge(e.source, e.target, { size: 1, weight: 1 });
    else g.updateEdgeAttribute(existing, "weight", (w: number | undefined) => (w ?? 1) + 1);
  }
  if (g.order > 1) {
    forceAtlas2.assign(g, {
      iterations: 150,
      settings: { ...forceAtlas2.inferSettings(g), barnesHutOptimize: g.order > 200 },
    });
  }
  return g;
}
