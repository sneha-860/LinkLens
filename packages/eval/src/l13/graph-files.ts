import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toCsv, type Cell } from "../corpus/csv.js";
import { STRUCTURAL_FEATURES, type GraphRepeat, type SiteGraph } from "./graph.js";

/**
 * The files analysis/ml/gnn.py reads, per site directory:
 * - `<g>.nodes.txt`: one node URL per line, in index order;
 * - `<g>.x.f32`: the node features, float32 little-endian, N × width row-major;
 * - `<g>.edges.csv`: `src,dst` body edges as node indices;
 * for g = `full` and each repeat `r<k>`, plus per repeat `r<k>.queries.csv` (`target,donor`) and
 * `r<k>.pairs.csv` (`target,donor,ref,cosine,hybrid`, URLs). `site.json` describes them with a
 * SHA-256 per file.
 */
export const GRAPHS_VERSION = "l13-graphs@1.0.0";

export interface SiteGraphsRecord {
  readonly embeddingDim: number;
  readonly width: number;
  readonly graphs: {
    readonly name: string;
    readonly repeat: number | null;
    readonly seed: number | null;
    readonly nodes: number;
    readonly edges: number;
    readonly queries: number;
    readonly pairs: number;
  }[];
  readonly sha256: Record<string, string>;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Little-endian float32 bytes (the platform order is not assumed). */
function f32(x: Float32Array): Buffer {
  const b = Buffer.alloc(x.length * 4);
  for (let i = 0; i < x.length; i++) b.writeFloatLE(x[i] as number, i * 4);
  return b;
}

export function writeSiteGraphs(
  dir: string,
  full: SiteGraph,
  repeats: readonly GraphRepeat[],
): SiteGraphsRecord {
  mkdirSync(dir, { recursive: true });
  const hashes: Record<string, string> = {};
  const put = (name: string, content: Buffer | string) => {
    writeFileSync(join(dir, name), content);
    hashes[name] = sha(content);
  };
  const width = full.embeddingDim + STRUCTURAL_FEATURES.length;
  const graphs: SiteGraphsRecord["graphs"][number][] = [];
  const writeGraph = (name: string, g: SiteGraph) => {
    if (g.embeddingDim !== full.embeddingDim) {
      throw new Error(`${name}: embedding width ${g.embeddingDim} ≠ ${full.embeddingDim}`);
    }
    put(`${name}.nodes.txt`, g.nodes.map((n) => `${n}\n`).join(""));
    put(`${name}.x.f32`, f32(g.x));
    put(
      `${name}.edges.csv`,
      toCsv(
        ["src", "dst"],
        g.src.map((s, i) => ({ src: s, dst: g.dst[i] as number })),
      ),
    );
  };
  writeGraph("full", full);
  graphs.push({
    name: "full",
    repeat: null,
    seed: null,
    nodes: full.nodes.length,
    edges: full.src.length,
    queries: 0,
    pairs: 0,
  });
  for (const r of repeats) {
    const name = `r${r.repeat}`;
    writeGraph(name, r.graph);
    put(`${name}.queries.csv`, toCsv(["target", "donor"], r.queries));
    put(
      `${name}.pairs.csv`,
      toCsv(
        ["target", "donor", "ref", "cosine", "hybrid"],
        r.pairs as unknown as Readonly<Record<string, Cell>>[],
      ),
    );
    graphs.push({
      name,
      repeat: r.repeat,
      seed: r.seed,
      nodes: r.graph.nodes.length,
      edges: r.graph.src.length,
      queries: r.queries.length,
      pairs: r.pairs.length,
    });
  }
  return { embeddingDim: full.embeddingDim, width, graphs, sha256: hashes };
}

/** Reads a `.x.f32` file back (tests; the Python side uses numpy). */
export function readF32(path: string): Float32Array {
  const b = readFileSync(path);
  const out = new Float32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}
