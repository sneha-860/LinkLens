import { db as q, fixes, type canonicalise, type db, type semantic } from "@linklens/core";
import { simulateInWorkers } from "./pool.js";
import type { TimedResult } from "./protocol.js";

export interface RuntimeSummary {
  readonly workers: number;
  readonly chunks: number;
  /** Wall-clock time of the parallel simulation, including worker start-up. */
  readonly wallMs: number;
  /** Per-candidate simulation time (in its worker). */
  readonly perCandidateMs: {
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
  };
}

export interface CounterfactualReport {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly candidatesVersion: string;
  readonly refVariant: semantic.RefVariant;
  readonly params: fixes.PageRankParams & {
    /** Weight of the simulated body link (prominenceRegionWeights.body). */
    readonly bodyWeight: number;
    readonly warmStart: true;
  };
  readonly baseline: {
    readonly nodes: number;
    readonly links: number;
    readonly seed: string;
    readonly iterations: number;
    readonly converged: boolean;
  };
  readonly validation: fixes.WarmStartValidation;
  readonly stats: {
    readonly candidates: number;
    readonly converged: number;
    readonly meanIterations: number;
  };
  /** One per candidate, in the candidate list's order. */
  readonly results: TimedResult[];
  /** Timing only: varies between runs and machines (every other field is deterministic). */
  readonly runtime: RuntimeSummary;
}

export interface PersistedCounterfactual extends CounterfactualReport {
  readonly artefact: db.ArtefactRow;
}

const quantile = (sorted: readonly number[], p: number) =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number);

/**
 * The counterfactual engine for a run under `policyId` (the run's stored config): for every fix
 * candidate (u,v), a copy of the prominence-weighted graph with u→v at the body weight (added,
 * or the existing link raised to it), PageRank recomputed warm-started from the baseline, and
 * ΔPR_v, the site-wide L1 change and Δdepth_v from the home page. Candidates are simulated in
 * parallel worker threads; a seeded sample is re-run from a cold start to check the warm start.
 * Appended as a `counterfactual` artefact.
 */
export async function buildCounterfactualRun(
  database: db.Queryable,
  runId: number,
  policyId: canonicalise.PolicyId,
  options: { readonly variant?: semantic.RefVariant; readonly workers?: number } = {},
): Promise<PersistedCounterfactual> {
  const inputs = await fixes.loadCounterfactualInputs(
    database,
    runId,
    policyId,
    options.variant ?? "weighted",
  );
  const { graph, scenarios, bodyWeight, config } = inputs;
  const base = fixes.baseline(graph, config);
  const params: fixes.PageRankParams = {
    pagerankDamping: config.pagerankDamping,
    pagerankTolerance: config.pagerankTolerance,
    pagerankMaxIterations: config.pagerankMaxIterations,
  };

  const pool = await simulateInWorkers(
    { graph, baseline: base, bodyWeight, params },
    scenarios,
    options.workers ?? config.counterfactualWorkers,
  );
  const validation = fixes.validateWarmStart(
    graph,
    base,
    scenarios,
    bodyWeight,
    params,
    config.counterfactualValidationSample,
    config.randomSeed,
  );

  const times = pool.results.map((r) => r.runtimeMs).sort((a, b) => a - b);
  const report: CounterfactualReport = {
    version: fixes.COUNTERFACTUAL_VERSION,
    runId,
    policyVersion: inputs.candidates.policyVersion,
    candidatesVersion: inputs.candidates.version,
    refVariant: inputs.candidates.refVariant,
    params: { ...params, bodyWeight, warmStart: true },
    baseline: {
      nodes: graph.nodes.length,
      links: graph.targets.length,
      seed: graph.nodes[graph.seed] as string,
      iterations: base.iterations,
      converged: base.converged,
    },
    validation,
    stats: {
      candidates: pool.results.length,
      converged: pool.results.filter((r) => r.converged).length,
      meanIterations:
        pool.results.length === 0
          ? 0
          : pool.results.reduce((s, r) => s + r.iterations, 0) / pool.results.length,
    },
    results: pool.results,
    runtime: {
      workers: pool.workers,
      chunks: pool.chunks,
      wallMs: pool.wallMs,
      perCandidateMs: {
        mean: times.length === 0 ? 0 : times.reduce((s, x) => s + x, 0) / times.length,
        p50: quantile(times, 0.5),
        p95: quantile(times, 0.95),
        max: times.at(-1) ?? 0,
      },
    },
  };
  const artefact = await q.insertArtefact(database, {
    runId,
    policyVersion: report.policyVersion,
    kind: fixes.COUNTERFACTUAL_ARTEFACT,
    payload: report as unknown as db.Json,
  });
  return { ...report, artefact };
}
