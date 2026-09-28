import { fixes, graph, importance as importanceCore, type LinkLensConfig } from "@linklens/core";

/**
 * L13 features of a candidate link u → v (the ML prioritiser's inputs). Every row is measured in
 * the world the ranking would see: for E6 labels the masked site (the hidden link removed, its
 * anchors stripped, text and embeddings rebuilt), so no feature carries the answer.
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
  g: graph.LinkGraph,
  importance: Record<string, importanceCore.NodeImportance>,
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
  const d = importanceCore.detachedImportance(url, config);
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
  return fixes.fixScore(deltaPr, fixes.sigmaValues(ref, cosine, config).refGateCosine, kappa);
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
    same_section: b(fixes.sectionOf(p.donor) === fixes.sectionOf(p.target)),
    donor_type: p.donorFacts.type,
    target_type: p.targetFacts.type,
  };
}
