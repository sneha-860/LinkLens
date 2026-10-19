import type { LinkLensConfig } from "../config.js";
import type { LinkGraph } from "../graph/build.js";
import { detachedImportance, type NodeImportance } from "../importance/importance.js";
import { regionClass } from "../prominence/weights.js";
import { sectionOf } from "./candidates.js";
import { fixScore, sigmaValues, type FixRecord } from "./scoring.js";

/**
 * L13 features of a candidate link u → v (the ML prioritiser's inputs), and the GraphSAGE node
 * features. Pure: the eval package builds its training rows with these, and the pipeline's
 * learnedScore / graphsageScore stages build the rows the trained models score, so training and
 * serving share one definition.
 *
 * The S score (ΔPR × σ_refGateCosine / κ) travels with each row as a baseline, never as a feature.
 */

export const NUMERIC_FEATURES = [
  "delta_pr",
  "depth_gain",
  "newly_reachable",
  "ref",
  "cosine",
  "jaccard",
  "omega_existing",
  "kappa",
  "template_reach",
  "donor_pagerank",
  "target_pagerank",
  "donor_depth",
  "target_depth",
  "donor_in",
  "donor_out",
  "target_in",
  "target_out",
  "donor_in_scc",
  "target_in_scc",
  "donor_importance",
  "target_importance",
  "same_section",
] as const;
export const CATEGORICAL_FEATURES = ["donor_type", "target_type"] as const;
export const FEATURES = [...NUMERIC_FEATURES, ...CATEGORICAL_FEATURES] as const;
export type Feature = (typeof FEATURES)[number];

export type PairFeatures = Record<(typeof NUMERIC_FEATURES)[number], number | null> &
  Record<(typeof CATEGORICAL_FEATURES)[number], string>;

/** What a row needs to know about one page. */
export interface NodeFacts {
  readonly pagerank: number;
  readonly depth: number | null;
  readonly inNeighbours: number;
  readonly outNeighbours: number;
  readonly inLargestScc: boolean;
  readonly type: string;
  readonly importance: number;
}

/** A node's facts from a derived graph and its page importance (undefined: not a node). */
export function nodeFacts(
  g: LinkGraph,
  importance: Readonly<Record<string, NodeImportance>>,
): (node: string) => NodeFacts | undefined {
  return (node) => {
    if (!g.hasNode(node)) return undefined;
    const a = g.getNodeAttributes(node);
    const imp = importance[node];
    return {
      pagerank: a.pagerank ?? 0,
      depth: a.depth ?? null,
      inNeighbours: a.inNeighbours ?? 0,
      outNeighbours: a.outNeighbours ?? 0,
      inLargestScc: a.inLargestScc === true,
      type: imp?.type ?? "other",
      importance: imp?.importance ?? 0,
    };
  };
}

/**
 * The facts of a page that is not a graph node (an orphan): no links, unreachable, PageRank as
 * given (its baseline rank in the graph it was added to), type and importance detached (L12).
 */
export function detachedFacts(
  url: string,
  pagerank: number,
  config: Pick<LinkLensConfig, "pageTypeRules" | "pageTypePriors" | "importanceWeights">,
): NodeFacts {
  const d = detachedImportance(url, config);
  return {
    pagerank,
    depth: null,
    inNeighbours: 0,
    outNeighbours: 0,
    inLargestScc: false,
    type: d.type,
    importance: d.importance,
  };
}

/** |S_A ∩ S_B| / |S_A ∪ S_B| of the donor view and the target view (as E6's jaccard). */
export function jaccardOf(donor: ReadonlySet<string>, target: ReadonlySet<string>): number {
  let inter = 0;
  for (const t of donor) if (target.has(t)) inter += 1;
  const union = donor.size + target.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** The default ranking's S (σ = cosine gated by REF > ε), the baseline the model is compared with. */
export function sScore(
  deltaPr: number,
  ref: number,
  cosine: number | null,
  kappa: number,
  config: Pick<LinkLensConfig, "epsilon" | "sigmaBlendLambda">,
): number {
  return fixScore(deltaPr, sigmaValues(ref, cosine, config).refGateCosine, kappa);
}

export interface PairInput {
  readonly donor: string;
  readonly target: string;
  readonly deltaPr: number;
  readonly depthBefore: number | null;
  readonly depthAfter: number | null;
  readonly ref: number;
  readonly cosine: number | null;
  readonly jaccard: number;
  /** ω of an existing u → v link, 0 when there is none. */
  readonly omega: number;
  readonly kappa: number;
  readonly templateReach: number;
  readonly donorFacts: NodeFacts;
  readonly targetFacts: NodeFacts;
}

/** Pure: the feature row of one candidate link. Unknown values are null (NaN for LightGBM). */
export function pairFeatures(p: PairInput): PairFeatures {
  const gain =
    p.depthBefore !== null && p.depthAfter !== null ? p.depthBefore - p.depthAfter : null;
  const b = (x: boolean) => (x ? 1 : 0);
  return {
    delta_pr: p.deltaPr,
    depth_gain: gain,
    newly_reachable: b(p.depthBefore === null && p.depthAfter !== null),
    ref: p.ref,
    cosine: p.cosine,
    jaccard: p.jaccard,
    omega_existing: p.omega,
    kappa: p.kappa,
    template_reach: p.templateReach,
    donor_pagerank: p.donorFacts.pagerank,
    target_pagerank: p.targetFacts.pagerank,
    donor_depth: p.donorFacts.depth,
    target_depth: p.targetFacts.depth,
    donor_in: p.donorFacts.inNeighbours,
    donor_out: p.donorFacts.outNeighbours,
    target_in: p.targetFacts.inNeighbours,
    target_out: p.targetFacts.outNeighbours,
    donor_in_scc: b(p.donorFacts.inLargestScc),
    target_in_scc: b(p.targetFacts.inLargestScc),
    donor_importance: p.donorFacts.importance,
    target_importance: p.targetFacts.importance,
    same_section: b(sectionOf(p.donor) === sectionOf(p.target)),
    donor_type: p.donorFacts.type,
    target_type: p.targetFacts.type,
  };
}

/** A fix's feature row (what the "learned" mode scores), with its id, ends, type and S. */
export interface FixFeatureRow extends PairFeatures {
  readonly fix_id: string;
  readonly donor: string;
  readonly target: string;
  readonly type: string;
  readonly rank_s: number;
  readonly s_score: number;
}

/** What fixFeatureRows looks up about the site (the unmasked world the ranking sees). */
export interface SiteLookups {
  readonly facts: (node: string) => NodeFacts | undefined;
  /** Each document's donor view S_A and target view S_B as term sets. */
  readonly donorTerms: ReadonlyMap<string, ReadonlySet<string>>;
  readonly targetTerms: ReadonlyMap<string, ReadonlySet<string>>;
}

const factsOf = (facts: (n: string) => NodeFacts | undefined, n: string): NodeFacts => {
  const f = facts(n);
  if (f === undefined) throw new Error(`${n} is not a node of the graph`);
  return f;
};

/**
 * Pure: the feature row of every fix of a ranking, in its order. Features do not depend on σ or
 * on the scoring mode (S_imp only reorders), so the rows of any ranking of a run are the same
 * per fix id.
 */
export function fixFeatureRows(
  ranked: readonly FixRecord[],
  site: SiteLookups,
  config: Pick<LinkLensConfig, "epsilon" | "sigmaBlendLambda">,
): FixFeatureRow[] {
  const none = new Set<string>();
  return ranked.map((f) => ({
    fix_id: f.id,
    donor: f.donor,
    target: f.target,
    type: f.type,
    rank_s: f.rank,
    s_score: sScore(f.deltaPr, f.ref, f.cosine, f.kappa, config),
    ...pairFeatures({
      donor: f.donor,
      target: f.target,
      deltaPr: f.deltaPr,
      depthBefore: f.depthBefore,
      depthAfter: f.depthAfter,
      ref: f.ref,
      cosine: f.cosine,
      jaccard: jaccardOf(
        site.donorTerms.get(f.donor) ?? none,
        site.targetTerms.get(f.target) ?? none,
      ),
      omega: f.prominence.omega ?? 0,
      kappa: f.kappa,
      templateReach: f.templateReach,
      donorFacts: factsOf(site.facts, f.donor),
      targetFacts: factsOf(site.facts, f.target),
    }),
  }));
}

// ---------- GraphSAGE node features ----------

/**
 * GraphSAGE node features after the embedding (analysis/ml/gnn.py reads them in this order).
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
    if (l.source === l.target || regionClass(l.domRegion) !== "body") continue;
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
    x.set(structuralFeatures(factsOf(facts, n), sorted.length), i * width + embeddingDim);
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
export function graphLinks(g: LinkGraph) {
  const out: { source: string; target: string; domRegion: string | null }[] = [];
  g.forEachEdge((_e, a, source, target) => {
    out.push({ source, target, domRegion: (a.domRegion as string | null | undefined) ?? null });
  });
  return out;
}
