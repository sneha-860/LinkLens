import {
  SIGMA_VARIANTS,
  canonicalise,
  db as q,
  discovery,
  fixes,
  graph,
  stats,
  type SigmaVariant,
} from "@linklens/core";
import { channelAblation } from "./e2-channels.js";
import { compareWithBaselines, loadDonorOptions } from "./e3-baselines.js";
import { compareSnapshots, snapshot } from "./e4-stability.js";
import { calibrate, parseScreamingFrog, type OurPage } from "./e5-screaming-frog.js";
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
  /** E5: a Screaming Frog "Internal: All" export. */
  readonly screamingFrogCsv?: string;
  /** E8: filled rating sheets (without: E8 produces the sheet to fill). */
  readonly ratingsCsv?: string;
  /** E6/E7: links to hide, and the seed. */
  readonly sample?: number;
  readonly seed?: number;
  /** E1/E3/E4: top k; E3: the σ of the ranking. */
  readonly k?: number;
  readonly sigma?: SigmaVariant;
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
    case "E1":
      result = await stats.compareRunPolicies(db, runId, policy, k, options.sigma);
      break;
    case "E2":
      result = channelAblation(await discovery.loadReconciliation(db, runId, policy));
      break;
    case "E3": {
      const {
        options: donors,
        seedNode,
        sigma,
      } = await loadDonorOptions(db, runId, policy, options.sigma);
      result = compareWithBaselines(donors, seedNode, sigma, seed);
      break;
    }
    case "E4": {
      if (options.runB === undefined)
        throw new Error("E4 needs a second run of the same site (runB)");
      result = compareSnapshots(
        await snapshot(db, runId, policy, k),
        await snapshot(db, options.runB, policy, k),
      );
      break;
    }
    case "E5": {
      if (options.screamingFrogCsv === undefined)
        throw new Error("E5 needs a Screaming Frog export (internal_all.csv)");
      const { observations, context, config } = await graph.loadRunGraphInputs(db, runId);
      const derived = graph.deriveGraphFromObservations(observations, policy, context, config);
      const ours: OurPage[] = [];
      derived.graph.forEachNode((n, a) => {
        if (a.crawled)
          ours.push({ url: n, depth: a.depth ?? null, inNeighbours: a.inNeighbours ?? 0 });
      });
      result = calibrate(ours, parseScreamingFrog(options.screamingFrogCsv), (u) =>
        canonicalise.POLICIES.P3.canonicalise(u, context),
      );
      break;
    }
    case "E6":
    case "E7": {
      const inputs = await loadRecoveryInputs(db, runId, policy);
      result = hideAndRecover(inputs, {
        sample: options.sample ?? 20,
        seed,
        ks: KS,
        // E6: the audit's own set-up; E7: every σ on the same pool (no REF pre-filter).
        sigmas: id === "E6" ? [options.sigma ?? inputs.config.sigmaVariant] : SIGMA_VARIANTS,
        requireRef: id === "E6",
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
        screamingFrogCsv: undefined,
        ratingsCsv: undefined,
      } as unknown as q.Json,
      result: result as q.Json,
    },
  });
  return { id, options, result, artefact };
}
