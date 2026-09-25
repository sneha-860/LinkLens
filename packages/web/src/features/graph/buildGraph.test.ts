import { describe, expect, it } from "vitest";
import type { GraphResponse } from "../../api/types.js";
import { buildDrawGraph } from "./buildGraph.js";
import { depthColour } from "./colours.js";

const data: GraphResponse = {
  policy: "P3",
  policyVersion: "P3@1.0.0",
  graph: {
    attributes: { nodes: 3, edges: 4 },
    nodes: [
      { key: "https://s.test/", attributes: { pagerank: 0.5, depth: 0 } },
      { key: "https://s.test/a", attributes: { pagerank: 0.3, depth: 1 } },
      { key: "https://s.test/o", attributes: { pagerank: 0.2, depth: null } },
    ],
    edges: [
      { source: "https://s.test/", target: "https://s.test/a" },
      { source: "https://s.test/", target: "https://s.test/a" }, // parallel link
      { source: "https://s.test/a", target: "https://s.test/" },
      { source: "https://s.test/a", target: "https://s.test/a" }, // self-loop
    ],
  },
};

describe("buildDrawGraph", () => {
  const g = buildDrawGraph(data);

  it("collapses parallel links into one weighted edge and drops self-loops", () => {
    expect(g.order).toBe(3);
    expect(g.size).toBe(2);
    expect(g.getEdgeAttribute(g.edge("https://s.test/", "https://s.test/a"), "weight")).toBe(2);
  });

  it("sizes nodes by PageRank and colours them by depth", () => {
    const home = g.getNodeAttributes("https://s.test/");
    const orphan = g.getNodeAttributes("https://s.test/o");
    expect(home.size).toBeGreaterThan(orphan.size);
    expect(home.color).toBe(depthColour(0));
    expect(orphan.color).toBe(depthColour(null));
  });

  it("lays the graph out the same way every time", () => {
    const again = buildDrawGraph(data);
    for (const n of g.nodes()) {
      expect(again.getNodeAttribute(n, "x")).toBe(g.getNodeAttribute(n, "x"));
      expect(again.getNodeAttribute(n, "y")).toBe(g.getNodeAttribute(n, "y"));
    }
  });
});
