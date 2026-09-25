import type { EmbeddingDtype } from "../config.js";
import type { RawDocument } from "../text/model.js";

/** Bump whenever the output can change (input assembly, pooling, cosine). */
export const COSINE_VERSION = "cosine@1.0.0";
export const COSINE_ARTEFACT = "cosine-matrix";

/** What is embedded for one page, before the body is cut to its first N model tokens. */
export interface EmbeddingInput {
  readonly node: string;
  /** The Title field (`<title>`, then `<h1>` unless it repeats the title), one per line. */
  readonly title: string;
  /** The main-content text. */
  readonly body: string;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The embedding input of a raw document (same fields as the text representation). */
export function embeddingInput(doc: RawDocument): EmbeddingInput {
  const title: string[] = [];
  for (const t of doc.title) if (!title.some((x) => same(x, t))) title.push(t.trim());
  return { node: doc.node, title: title.join("\n"), body: doc.body.join("\n").trim() };
}

/** Position of (i, j), i < j, in a row-major strict upper triangle of an n × n matrix. */
export function packedIndex(n: number, i: number, j: number): number {
  if (!(i < j && j < n)) throw new RangeError(`need i < j < n, got ${i}, ${j}, ${n}`);
  return i * n - (i * (i + 1)) / 2 + (j - i - 1);
}

/**
 * cos(u, v) for every pair of vectors, as the strict upper triangle (row-major) of the symmetric
 * matrix. Accumulated in float64. A zero vector has cosine 0 with everything.
 */
export function cosineUpper(vectors: readonly Float32Array[]): Float64Array {
  const n = vectors.length;
  const norms = vectors.map((v) => Math.sqrt(dot(v, v)));
  const out = new Float64Array((n * (n - 1)) / 2);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const a = vectors[i] as Float32Array;
    for (let j = i + 1; j < n; j++) {
      const b = vectors[j] as Float32Array;
      if (b.length !== a.length) throw new RangeError("vectors differ in length");
      const d = (norms[i] as number) * (norms[j] as number);
      out[k++] = d === 0 ? 0 : dot(a, b) / d;
    }
  }
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

export interface CosineMatrix {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly model: string;
  readonly dtype: EmbeddingDtype;
  readonly bodyTokens: number;
  readonly dimensions: number;
  /** Document nodes, sorted. */
  readonly nodes: string[];
  /** Per node: the embedding cache key (hash of model, settings and input). */
  readonly contentKeys: string[];
  /** Strict upper triangle, row-major: cos(nodes[i], nodes[j]) at packedIndex(n, i, j). */
  readonly upper: number[];
}

/** cos(u, v) by node id: 1 for u = v; null if either node is not in the matrix. */
export function cosineOf(m: CosineMatrix, u: string, v: string): number | null {
  const i = m.nodes.indexOf(u);
  const j = m.nodes.indexOf(v);
  if (i < 0 || j < 0) return null;
  if (i === j) return 1;
  const [a, b] = i < j ? [i, j] : [j, i];
  return m.upper[packedIndex(m.nodes.length, a, b)] ?? null;
}
