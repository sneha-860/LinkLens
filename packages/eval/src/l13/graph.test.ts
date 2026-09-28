import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NodeFacts } from "./features.js";
import { readF32, writeSiteGraphs } from "./graph-files.js";
import { STRUCTURAL_FEATURES, siteGraph, structuralFeatures } from "./graph.js";

const S = "https://s.test";
const facts = (over: Partial<NodeFacts> = {}): NodeFacts => ({
  pagerank: 0.25,
  depth: 1,
  inNeighbours: 3,
  outNeighbours: 0,
  inLargestScc: true,
  type: "article",
  importance: 0.5,
  ...over,
});

describe("structuralFeatures", () => {
  it("normalises PageRank by the node count, inverts depth and logs the degrees", () => {
    expect(structuralFeatures(facts(), 4)).toEqual([1, 0.5, 1, Math.log(4), 0, 0.5]);
    // Unreachable: depth features are 0.
    expect(structuralFeatures(facts({ depth: null }), 4).slice(1, 3)).toEqual([0, 0]);
    expect(STRUCTURAL_FEATURES).toHaveLength(6);
  });
});

describe("siteGraph", () => {
  const nodes = [`${S}/c`, `${S}/a`, `${S}/b`];
  const vec = (n: string) => Float32Array.from(n.endsWith("a") ? [1, 0] : [0, 1]);
  const links = [
    { source: `${S}/a`, target: `${S}/b`, domRegion: "main" },
    { source: `${S}/a`, target: `${S}/b`, domRegion: null }, // parallel: one edge
    { source: `${S}/b`, target: `${S}/c`, domRegion: "nav" }, // chrome: dropped
    { source: `${S}/c`, target: `${S}/c`, domRegion: "main" }, // self-loop: dropped
    { source: `${S}/c`, target: `${S}/x`, domRegion: "body" }, // no text: dropped
    { source: `${S}/c`, target: `${S}/a`, domRegion: "body" },
  ];
  const g = siteGraph(nodes, links, () => facts(), vec, 2);

  it("keeps distinct body edges between pages with text, nodes sorted", () => {
    expect(g.nodes).toEqual([`${S}/a`, `${S}/b`, `${S}/c`]);
    expect(g.src.map((s, i) => [s, g.dst[i]])).toEqual([
      [0, 1],
      [2, 0],
    ]);
  });

  it("puts the embedding first, then the structural features", () => {
    const width = 2 + STRUCTURAL_FEATURES.length;
    expect(g.x).toHaveLength(3 * width);
    expect([...g.x.slice(0, 2)]).toEqual([1, 0]);
    expect(g.x[2]).toBeCloseTo(0.75, 6); // PageRank 0.25 × 3 nodes
  });

  it("refuses an embedding of the wrong width", () => {
    expect(() =>
      siteGraph(
        nodes,
        [],
        () => facts(),
        () => new Float32Array(3),
        2,
      ),
    ).toThrow(/length 3/);
  });

  it("writes the files the Python side reads, with their hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "l13-graphs-"));
    try {
      const rec = writeSiteGraphs(dir, g, [
        {
          repeat: 0,
          seed: 42,
          graph: g,
          queries: [{ target: `${S}/b`, donor: `${S}/a` }],
          pairs: [
            { target: `${S}/b`, donor: `${S}/a`, ref: 0.5, cosine: 0.1, hybrid: 0.1 },
            { target: `${S}/b`, donor: `${S}/c`, ref: 0, cosine: null, hybrid: 0 },
          ],
        },
      ]);
      expect(rec.graphs.map((x) => [x.name, x.edges, x.queries, x.pairs])).toEqual([
        ["full", 2, 0, 0],
        ["r0", 2, 1, 2],
      ]);
      expect([...readF32(join(dir, "r0.x.f32"))]).toEqual([...g.x]);
      // RFC 4180 line endings (the corpus CSV writer's); pandas reads either.
      expect(readFileSync(join(dir, "full.edges.csv"), "utf8")).toBe("src,dst\r\n0,1\r\n2,0\r\n");
      expect(readFileSync(join(dir, "r0.pairs.csv"), "utf8").split("\r\n")[2]).toBe(
        `${S}/b,${S}/c,0,,0`,
      );
      expect(Object.keys(rec.sha256)).toContain("r0.queries.csv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
