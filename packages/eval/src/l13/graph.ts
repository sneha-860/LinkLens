import {
  canonicalise,
  fixes,
  graph,
  prominence,
  semantic,
  text,
  type LinkLensConfig,
} from "@linklens/core";
import type { Embedder } from "@linklens/embeddings";
import { editorialSite, maskSite, maskedInputs } from "../e6-masking.js";
import { prepareRun, type RunInputs } from "../in-memory.js";
import { nodeFacts, type NodeFacts } from "./features.js";

type PolicyId = canonicalise.PolicyId;

/**
 * GraphSAGE inputs for one audited run (analysis/ml/gnn.py). One graph per world: the unmasked
 * site ("full", which scores the fixes) and each of E6's `e6Repeats` masked repeats (E6's own
 * masking, seeds randomSeed + r, so the masked links are absent from the graph and their anchors
 * from the text and embeddings). Nodes are the pages with text (the documents every E6
 * candidate and every fix end comes from), sorted; edges are distinct body-region links between
 * them (`regionClass` body: main, body or none), self-loops dropped.
 *
 * Node features: the page's embedding (the run's model, as E6 embeds it), then the structural
 * ones in `STRUCTURAL_FEATURES`.
 */
export const STRUCTURAL_FEATURES = [
  // PageRank × N: 1 is the average page, whatever the site's size.
  "pagerank_norm",
  // 1 / (1 + depth) from the home page; 0 when unreachable.
  "depth_inv",
  "reachable",
  // ln(1 + distinct in / out neighbours) in the policy's whole link graph.
  "log_in",
  "log_out",
  "importance",
] as const;

export interface SiteGraph {
  readonly nodes: string[];
  readonly embeddingDim: number;
  /** N × (embeddingDim + STRUCTURAL_FEATURES.length), row-major. */
  readonly x: Float32Array;
  /** Body edges as node indices. */
  readonly src: number[];
  readonly dst: number[];
}

/** One masked repeat: its graph, E6's queries and every (target, candidate) pair to score. */
export interface GraphRepeat {
  readonly repeat: number;
  readonly seed: number;
  readonly graph: SiteGraph;
  /** Masked links that are E6 queries (both ends have text; the donor no longer links). */
  readonly queries: { readonly target: string; readonly donor: string }[];
  /**
   * Each query target's candidate pool (every page with text but the target and pages that
   * still link to it; a query drops the target's other masked donors), with the baselines.
   */
  readonly pairs: {
    readonly target: string;
    readonly donor: string;
    readonly ref: number;
    readonly cosine: number | null;
    readonly hybrid: number;
  }[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: a node's structural features (STRUCTURAL_FEATURES order). */
export function structuralFeatures(f: NodeFacts, nodeCount: number): number[] {
  return [
    f.pagerank * nodeCount,
    f.depth === null ? 0 : 1 / (1 + f.depth),
    f.depth === null ? 0 : 1,
    Math.log1p(f.inNeighbours),
    Math.log1p(f.outNeighbours),
    f.importance,
  ];
}

/**
 * Pure: the graph of the documents `nodes` (sorted here): body edges from `links` (u, v and the
 * observation's dom_region; parallel links collapse, self-loops and ends without text drop), the
 * embedding (zeros when missing) and the structural features from `facts`.
 */
export function siteGraph(
  nodes: readonly string[],
  links: Iterable<{ source: string; target: string; domRegion: string | null }>,
  facts: (n: string) => NodeFacts | undefined,
  vector: (n: string) => Float32Array | undefined,
  embeddingDim: number,
): SiteGraph {
  const sorted = [...nodes].sort(cmp);
  const index = new Map(sorted.map((n, i) => [n, i]));
  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  for (const l of links) {
    if (l.source === l.target || prominence.regionClass(l.domRegion) !== "body") continue;
    const u = index.get(l.source);
    const v = index.get(l.target);
    if (u === undefined || v === undefined) continue;
    const key = `${u},${v}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([u, v]);
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const width = embeddingDim + STRUCTURAL_FEATURES.length;
  const x = new Float32Array(sorted.length * width);
  sorted.forEach((n, i) => {
    const v = vector(n);
    if (v !== undefined) {
      if (v.length !== embeddingDim) {
        throw new Error(`${n}: embedding of length ${v.length}, expected ${embeddingDim}`);
      }
      x.set(v, i * width);
    }
    const f = facts(n);
    if (f === undefined) throw new Error(`${n} is not a node of the graph`);
    x.set(structuralFeatures(f, sorted.length), i * width + embeddingDim);
  });
  return {
    nodes: sorted,
    embeddingDim,
    x,
    src: pairs.map((p) => p[0]),
    dst: pairs.map((p) => p[1]),
  };
}

/** The link observations of a derived graph, with their region. */
function linksOf(g: graph.LinkGraph) {
  const out: { source: string; target: string; domRegion: string | null }[] = [];
  g.forEachEdge((_e, a, source, target) => {
    out.push({ source, target, domRegion: (a.domRegion as string | null | undefined) ?? null });
  });
  return out;
}

async function embed(
  embedder: Embedder,
  documents: readonly text.RawDocument[],
): Promise<Map<string, Float32Array>> {
  const inputs = documents.map(semantic.embeddingInput).sort((a, b) => cmp(a.node, b.node));
  const { vectors } = await embedder.embed(inputs.map(({ title, body }) => ({ title, body })));
  return new Map(inputs.map((d, i) => [d.node, vectors[i] as Float32Array]));
}

/** The unmasked site's graph (scores the fixes). */
export async function fullGraph(
  inputs: RunInputs,
  policyId: PolicyId,
  embedder: Embedder,
): Promise<SiteGraph> {
  const prepared = prepareRun(inputs, { policyId });
  const st = prepared.state;
  const vectors = await embed(embedder, st.documents);
  return siteGraph(
    st.model.documents.map((d) => d.node),
    linksOf(st.graph),
    nodeFacts(st.graph, prepared.importance().nodes),
    (n) => vectors.get(n),
    firstLength(vectors),
  );
}

const firstLength = (m: Map<string, Float32Array>) => [...m.values()][0]?.length ?? 0;

/**
 * Every E6 repeat (e6Repeats; seeds randomSeed + r): the masked graph, its queries and the pairs
 * to score, with REF, cosine and the hybrid σ exactly as E6 computes them (tested).
 */
export async function graphRepeats(
  inputs: RunInputs,
  policyId: PolicyId,
  embedder: Embedder,
  config: Readonly<LinkLensConfig> = inputs.config,
): Promise<GraphRepeat[]> {
  const site = editorialSite(inputs, policyId);
  const out: GraphRepeat[] = [];
  for (let r = 0; r < config.e6Repeats; r++) {
    const seed = config.randomSeed + r;
    const m = maskSite(inputs, site, seed, config);
    const prepared = prepareRun({ ...maskedInputs(inputs, m), cosine: null }, { policyId });
    const st = prepared.state;
    const vectors = await embed(embedder, m.documents);
    const docs = [...st.model.documents].sort((a, b) => cmp(a.node, b.node));
    const byNode = new Map(docs.map((d) => [d.node, d]));
    const donorSet = new Map(docs.map((d) => [d.node, new Set(d.donor)]));
    const cosine = (u: string, v: string): number | null => {
      const a = vectors.get(u);
      const b = vectors.get(v);
      if (a === undefined || b === undefined) return null;
      let dot = 0;
      for (let k = 0; k < a.length; k++) dot += (a[k] as number) * (b[k] as number);
      return dot;
    };
    const byTarget = new Map<string, string[]>();
    for (const x of m.masked) {
      if (!byNode.has(x.donor) || !byNode.has(x.target)) continue;
      byTarget.set(x.target, [...(byTarget.get(x.target) ?? []), x.donor]);
    }
    const queries: GraphRepeat["queries"] = [];
    const pairs: GraphRepeat["pairs"][number][] = [];
    for (const [target, maskedDonors] of [...byTarget].sort((a, b) => cmp(a[0], b[0]))) {
      const pool = docs
        .map((d) => d.node)
        .filter((u) => u !== target && !st.graph.hasDirectedEdge(u, target));
      const kept = maskedDonors.filter((d) => pool.includes(d)).sort(cmp);
      if (kept.length === 0) continue;
      for (const donor of kept) queries.push({ target, donor });
      const tw = semantic.targetWeights(byNode.get(target) as text.TextDocument);
      for (const u of pool) {
        const ref = semantic.ref(donorSet.get(u) as Set<string>, tw, "weighted");
        const cos = cosine(u, target);
        pairs.push({
          target,
          donor: u,
          ref,
          cosine: cos,
          hybrid: fixes.sigmaValues(ref, cos, config).refGateCosine,
        });
      }
    }
    out.push({
      repeat: r,
      seed,
      graph: siteGraph(
        docs.map((d) => d.node),
        linksOf(st.graph),
        nodeFacts(st.graph, prepared.importance().nodes),
        (n) => vectors.get(n),
        firstLength(vectors),
      ),
      queries,
      pairs,
    });
  }
  return out;
}
