import { db as q, fixes, type canonicalise, type db, type semantic } from "@linklens/core";
import { simulateInWorkers } from "./pool.js";

export interface RescueReport {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly refVariant: semantic.RefVariant;
  readonly params: {
    readonly topK: number;
    /** REF shortlist size per orphan (candidateMaxPerTarget). */
    readonly shortlist: number;
    readonly epsilon: number;
    readonly bodyWeight: number;
  };
  readonly baseline: {
    readonly nodes: number;
    readonly links: number;
    /** Orphan nodes added to the graph because no crawled page links to them. */
    readonly orphanNodesAdded: number;
    readonly iterations: number;
    readonly converged: boolean;
  };
  readonly counts: {
    readonly orphans: number;
    readonly scored: number;
    readonly noPage: number;
    readonly noText: number;
    readonly withDonors: number;
    readonly simulations: number;
  };
  readonly orphans: fixes.RescuedOrphan[];
}

export interface PersistedRescue extends RescueReport {
  readonly artefact: db.ArtefactRow;
}

/**
 * Orphan rescue for a run under `policyId` (the run's stored config), after `RescueFetcher` has
 * fetched the orphans' pages: for each reconciled orphan, the donors with REF(u, orphan) > ε
 * (shortlisted by REF), each simulated by the counterfactual engine (donor → orphan at the body
 * weight, in worker threads), then ordered by ΔPR of the orphan; the top rescueTopK are reported
 * with the channels that revealed the orphan. Appended as an `orphan-rescue` artefact.
 */
export async function buildRescueRun(
  database: db.Queryable,
  runId: number,
  policyId: canonicalise.PolicyId,
  options: { readonly variant?: semantic.RefVariant; readonly workers?: number } = {},
): Promise<PersistedRescue> {
  const inputs = await fixes.loadRescueInputs(
    database,
    runId,
    policyId,
    options.variant ?? "weighted",
  );
  const { graph, config } = inputs;
  const shortlists = fixes.rescueShortlists(
    inputs.orphans,
    inputs.model,
    inputs.depth,
    inputs.refVariant,
    config,
  );

  const index = new Map(graph.nodes.map((n, i) => [n, i]));
  const scenarios: fixes.Scenario[] = shortlists.flatMap((s) =>
    s.shortlist.map((e) => ({
      id: fixes.rescueId(e.donor, s.orphan.node),
      donor: index.get(e.donor) as number,
      target: index.get(s.orphan.node) as number,
      action: "add-link" as const,
    })),
  );
  const params: fixes.PageRankParams = {
    pagerankDamping: config.pagerankDamping,
    pagerankTolerance: config.pagerankTolerance,
    pagerankMaxIterations: config.pagerankMaxIterations,
  };
  const base = fixes.baseline(graph, params);
  const pool = await simulateInWorkers(
    { graph, baseline: base, bodyWeight: inputs.bodyWeight, params },
    scenarios,
    options.workers ?? config.counterfactualWorkers,
  );
  const orphans = fixes.rankRescue(
    shortlists,
    new Map(pool.results.map((r) => [r.candidateId, r])),
    config,
  );

  const report: RescueReport = {
    version: fixes.RESCUE_VERSION,
    runId,
    policyVersion: inputs.policyVersion,
    refVariant: inputs.refVariant,
    params: {
      topK: config.rescueTopK,
      shortlist: config.candidateMaxPerTarget,
      epsilon: config.epsilon,
      bodyWeight: inputs.bodyWeight,
    },
    baseline: {
      nodes: graph.nodes.length,
      links: graph.targets.length,
      orphanNodesAdded: inputs.orphanNodesAdded,
      iterations: base.iterations,
      converged: base.converged,
    },
    counts: {
      orphans: orphans.length,
      scored: orphans.filter((o) => o.status === "scored").length,
      noPage: orphans.filter((o) => o.status === "no-page").length,
      noText: orphans.filter((o) => o.status === "no-text").length,
      withDonors: orphans.filter((o) => o.donors.length > 0).length,
      simulations: scenarios.length,
    },
    orphans,
  };
  const artefact = await q.insertArtefact(database, {
    runId,
    policyVersion: report.policyVersion,
    kind: fixes.RESCUE_ARTEFACT,
    payload: report as unknown as db.Json,
  });
  return { ...report, artefact };
}
