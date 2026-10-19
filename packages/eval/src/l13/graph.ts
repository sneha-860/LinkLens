import { canonicalise, fixes, semantic, text, type LinkLensConfig } from "@linklens/core";
import type { Embedder } from "@linklens/embeddings";
import { editorialSite, maskSite, maskedInputs } from "../e6-masking.js";
import { prepareRun, type RunInputs } from "../in-memory.js";
import { nodeFacts } from "./features.js";

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
 * ones in `STRUCTURAL_FEATURES`. The pure graph builders live in core (`fixes/features.ts`), so
 * the pipeline's graphsageScore stage builds the graph it scores exactly as training did.
 */
export const { STRUCTURAL_FEATURES, structuralFeatures, siteGraph } = fixes;
export type SiteGraph = fixes.SiteGraph;

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
const linksOf = fixes.graphLinks;

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
