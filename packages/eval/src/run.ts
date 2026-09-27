import {
  SIGMA_VARIANTS,
  canonicalise,
  db as q,
  discovery,
  fixes,
  stats,
  type SigmaVariant,
} from "@linklens/core";
import { channelAblation } from "./e2-channels.js";
import type { Embedder } from "@linklens/embeddings";
import { compareE3, loadE3Inputs } from "./e3-baselines.js";
import { compareStoredRuns } from "./e4-stability.js";
import { calibrateRun, parseExports, type ScreamingFrogCsvs } from "./e5-screaming-frog.js";
import { maskingRecovery } from "./e6-masking.js";
import { loadRunInputs } from "./in-memory.js";
import { parseRatings, ratingSheet, summariseRatings } from "./e8-ratings.js";
import { experiments } from "./experiments.js";
import { hideAndRecover, loadRecoveryInputs } from "./recovery.js";

type PolicyId = canonicalise.PolicyId;
export type ExperimentId = (typeof experiments)[number]["id"];

export interface ExperimentOptions {
  readonly runId: number;
  readonly policy: PolicyId;
  /** E4: the later crawl of the same site. */
  readonly runB?: number;
  /** E5: Screaming Frog exports (Internal: All, and optionally All Inlinks and Orphan pages). */
  readonly screamingFrog?: ScreamingFrogCsvs;
  /** E8: filled rating sheets (without: E8 produces the sheet to fill). */
  readonly ratingsCsv?: string;
  /** E6/E7: links to hide, and the seed. */
  readonly sample?: number;
  readonly seed?: number;
  /** E1/E4: top k; E3: one k instead of config.e3TopKs. E3: the σ of LinkLens's score. */
  readonly k?: number;
  readonly sigma?: SigmaVariant;
  /** E3 and E6: embeds pages (E3: the orphans; E6: the masked site); the run's model. */
  readonly embedder?: Embedder;
}

export interface ExperimentRun {
  readonly id: ExperimentId;
  readonly options: ExperimentOptions;
  readonly result: unknown;
  readonly artefact: q.ArtefactRow;
}

const KS = [1, 3, 5, 10];

/** Run one experiment on a run (and a second run for E4); the result is stored as an artefact. */
export async function runExperiment(
  db: q.Queryable,
  id: ExperimentId,
  options: ExperimentOptions,
): Promise<ExperimentRun> {
  const { runId, policy } = options;
  const k = options.k ?? 10;
  const seed = options.seed ?? 42;
  let result: unknown;
  switch (id) {
    case "E1": {
      // Each policy against the audit's (the /sensitivity table), and every pair of policies.
      const snapshots = await stats.loadPolicySnapshots(db, runId, k, options.sigma);
      result = {
        ...stats.sensitivityFromSnapshots(snapshots, policy),
        pairs: stats.comparePolicyPairs(snapshots).pairs,
      };
      break;
    }
    case "E2": {
      // Subsets of the non-link channels, and each of the six removed in turn (reconciled again).
      const input = await discovery.loadReconcileInput(db, runId, policy);
      const loo = discovery.leaveOneChannelOut(input);
      result = {
        ...channelAblation(discovery.reconcile(input)),
        orphansBy: loo.orphansBy,
        removals: loo.removals,
      };
      break;
    }
    case "E3": {
      if (options.embedder === undefined)
        throw new Error("E3 needs an embedder with the run's embedding model (for the orphans)");
      const { inputs, config } = await loadE3Inputs(db, runId, policy, options.embedder, {
        ...(options.sigma === undefined ? {} : { sigma: options.sigma }),
      });
      result = compareE3(
        inputs,
        options.k === undefined ? config.e3TopKs : [options.k],
        config.e3RandomDraws,
        options.seed ?? config.randomSeed,
      );
      break;
    }
    case "E4": {
      if (options.runB === undefined)
        throw new Error("E4 needs a second run of the same site (runB)");
      result = await compareStoredRuns(db, runId, options.runB, {
        policyId: policy,
        ...(options.k === undefined ? {} : { k: options.k }),
        ...(options.sigma === undefined ? {} : { sigma: options.sigma }),
      });
      break;
    }
    case "E5": {
      if (options.screamingFrog === undefined)
        throw new Error("E5 needs Screaming Frog exports (at least internal_all.csv)");
      const inputs = await loadRunInputs(db, runId, policy);
      const policies: PolicyId[] = policy === "P0" ? ["P0"] : ["P0", policy];
      result = calibrateRun(inputs, parseExports(options.screamingFrog), policies, inputs.config);
      break;
    }
    case "E6": {
      if (options.embedder === undefined)
        throw new Error("E6 needs an embedder with the run's embedding model (it re-embeds)");
      const inputs = await loadRunInputs(db, runId, policy);
      result = await maskingRecovery(
        inputs,
        policy,
        options.embedder,
        options.seed ?? inputs.config.randomSeed,
      );
      break;
    }
    case "E7": {
      // Every σ on the same pool (no REF pre-filter), on the fix pipeline's candidates.
      const inputs = await loadRecoveryInputs(db, runId, policy);
      result = hideAndRecover(inputs, {
        sample: options.sample ?? 20,
        seed,
        ks: KS,
        sigmas: SIGMA_VARIANTS,
        requireRef: false,
      });
      break;
    }
    case "E8": {
      if (options.ratingsCsv !== undefined) {
        result = summariseRatings(parseRatings(options.ratingsCsv));
      } else {
        const version = canonicalise.POLICIES[policy].version;
        const [rankings, expl] = await Promise.all([
          q.listArtefacts(db, runId, { kind: fixes.FIX_RANKING_ARTEFACT, policyVersion: version }),
          q.listArtefacts(db, runId, { kind: fixes.EXPLANATIONS_ARTEFACT, policyVersion: version }),
        ]);
        const ranking = rankings.at(-1)?.payload as unknown as fixes.FixRanking | undefined;
        if (ranking === undefined) throw new Error(`run ${runId} has no fix ranking to rate`);
        const sentence = new Map(
          ((expl.at(-1)?.payload as unknown as fixes.ExplanationSet | undefined)?.fixes ?? []).map(
            (e) => [e.id, e.sentence],
          ),
        );
        result = {
          sheet: ratingSheet(
            ranking.fixes.slice(0, options.k ?? 50).map((f) => ({
              id: f.id,
              rank: f.rank,
              donor: f.donor,
              target: f.target,
              type: f.type,
              score: f.score,
              explanation: sentence.get(f.id) ?? "",
            })),
          ),
        };
      }
      break;
    }
  }
  const artefact = await q.insertArtefact(db, {
    runId,
    policyVersion: canonicalise.POLICIES[policy].version,
    kind: `evaluation-${id}`,
    payload: {
      experiment: id,
      options: {
        ...options,
        screamingFrog: undefined,
        ratingsCsv: undefined,
        embedder: undefined,
      } as unknown as q.Json,
      result: result as q.Json,
    },
  });
  return { id, options, result, artefact };
}
