import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import type { LinkLensConfig } from "../config.js";
import type { Queryable } from "../db/types.js";
import { buildLinkGraph } from "../graph/build.js";
import { loadRunGraphInputs } from "../graph/derive.js";
import { makeInternalTest } from "../graph/scope.js";
import type { RefVariant } from "../semantic/ref.js";
import { loadCandidates, type CandidateList } from "./candidates.js";
import { weightedGraph, type Scenario, type WeightedGraph } from "./counterfactual.js";

export interface CounterfactualInputs {
  readonly candidates: CandidateList;
  /** Every node of the policy's link graph, weighted by structural prominence W(u,v). */
  readonly graph: WeightedGraph;
  readonly scenarios: Scenario[];
  /** The weight a simulated body link gets: config.prominenceRegionWeights.body. */
  readonly bodyWeight: number;
  readonly config: Readonly<LinkLensConfig>;
}

/**
 * Everything the counterfactual engine needs for a run under `policyId` (the run's stored
 * config): the fix candidates, the weighted link graph (all graph nodes; links weighted by their
 * structural prominence W, never by analytics clicks, so every row is in the same unit as the
 * body weight added) and one scenario per candidate. Nothing is written.
 */
export async function loadCounterfactualInputs(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
  variant: RefVariant = "weighted",
): Promise<CounterfactualInputs> {
  const [{ list, prominence, config }, { observations, context }] = await Promise.all([
    loadCandidates(db, runId, policyId, variant),
    loadRunGraphInputs(db, runId),
  ]);
  const policy = POLICIES[policyId];
  const { graph, seedNode } = buildLinkGraph({
    seedUrl: observations.seedUrl,
    pages: observations.pages,
    links: observations.links,
    isInternal: makeInternalTest(observations.seedUrl, config.includeSubdomains),
    canonicalise: (url) => policy.canonicalise(url, context),
  });
  const g = weightedGraph(
    graph.nodes(),
    seedNode,
    prominence.edges.map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.structuralWeight,
    })),
  );
  const index = new Map(g.nodes.map((n, i) => [n, i]));
  const scenarios = list.candidates.map((c) => ({
    id: c.id,
    donor: index.get(c.donor) as number,
    target: index.get(c.target) as number,
    action: c.action,
  }));
  return {
    candidates: list,
    graph: g,
    scenarios,
    bodyWeight: config.prominenceRegionWeights.body,
    config,
  };
}
