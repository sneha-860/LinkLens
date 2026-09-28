import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import {
  getRun,
  insertArtefact,
  insertFixRating,
  listArtefacts,
  listFixRatings,
} from "../db/queries.js";
import type { ArtefactRow, FixRatingRow, Json, Placement, Queryable, Rater } from "../db/types.js";
import { makeConfig, type SigmaVariant } from "../config.js";
import type { ExplanationSet } from "../fixes/explain-run.js";
import { EXPLANATIONS_ARTEFACT } from "../fixes/explain.js";
import { FIX_RANKING_ARTEFACT, type FixRanking } from "../fixes/scoring.js";
import { loadRunDocuments } from "../text/run.js";
import {
  RATING_SAMPLE_ARTEFACT,
  RATING_VERSION,
  sampleForRating,
  summariseRatings,
  type RatingSample,
  type RatingSummary,
} from "./rating.js";

export interface StoredRatingSample extends RatingSample {
  readonly artefactId: number;
}

const stored = (row: ArtefactRow): StoredRatingSample => ({
  ...(row.payload as unknown as RatingSample),
  artefactId: row.id,
});

/** The run's latest rating sample under `policyId`, or null. */
export async function loadRatingSample(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<StoredRatingSample | null> {
  const rows = await listArtefacts(db, runId, {
    kind: RATING_SAMPLE_ARTEFACT,
    policyVersion: POLICIES[policyId].version,
  });
  const row = rows.at(-1);
  return row === undefined ? null : stored(row);
}

/**
 * Draw a blind rating sample from the latest fix ranking for `sigma` (else the latest ranking)
 * and append it as a `rating-sample` artefact. The run's stored config gives the pool, size and
 * seed (randomSeed); page titles come from the representative pages, and each item's suggested
 * placement from the latest explanations (null when there are none).
 */
export async function buildRatingSample(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
  sigma?: SigmaVariant,
): Promise<StoredRatingSample> {
  const policyVersion = POLICIES[policyId].version;
  const [rankings, explanations, run] = await Promise.all([
    listArtefacts(db, runId, { kind: FIX_RANKING_ARTEFACT, policyVersion }),
    listArtefacts(db, runId, { kind: EXPLANATIONS_ARTEFACT, policyVersion }),
    getRun(db, runId),
  ]);
  const ranking =
    rankings.filter((r) => (r.payload as unknown as FixRanking).sigmaVariant === sigma).at(-1) ??
    rankings.at(-1);
  if (ranking === undefined) throw new Error(`run ${runId} has no fix ranking under ${policyId}`);
  const fixes = (ranking.payload as unknown as FixRanking).fixes;
  const expl = explanations.at(-1);
  const placementOf = new Map(
    ((expl?.payload as unknown as ExplanationSet | undefined)?.fixes ?? []).map((e) => [
      e.id,
      e.anchor ?? null,
    ]),
  );
  const config = makeConfig(run?.config ?? {});
  const { documents } = await loadRunDocuments(db, runId, policyId);
  const titleOf = new Map(documents.map((d) => [d.node, d.title[0] ?? null]));

  const pool = Math.min(config.ratingPoolSize, fixes.length);
  const size = Math.min(config.ratingSampleSize, pool);
  const items = sampleForRating(
    fixes,
    { title: (n) => titleOf.get(n) ?? null, placement: (id) => placementOf.get(id) ?? null },
    { pool, size, seed: config.randomSeed },
  );
  const sample: RatingSample = {
    version: RATING_VERSION,
    runId,
    policyVersion,
    sigmaVariant: (ranking.payload as unknown as FixRanking).sigmaVariant,
    sources: { fixRankingArtefactId: ranking.id, explanationsArtefactId: expl?.id ?? null },
    pool,
    size,
    seed: config.randomSeed,
    items,
  };
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion,
    kind: RATING_SAMPLE_ARTEFACT,
    payload: sample as unknown as Json,
  });
  return { ...sample, artefactId: artefact.id };
}

export class RatingError extends Error {
  override readonly name = "RatingError";
}

/**
 * Record one rater's answer for an item of the sample (appended; the latest counts). An item
 * marked not relevant has placement "na".
 */
export async function recordRating(
  db: Queryable,
  sample: StoredRatingSample,
  input: {
    readonly itemId: string;
    readonly rater: Rater;
    readonly raterName: string;
    readonly relevant: boolean;
    readonly placement: Placement;
  },
): Promise<FixRatingRow> {
  if (!sample.items.some((i) => i.itemId === input.itemId)) {
    throw new RatingError(`item ${input.itemId} is not in rating sample ${sample.artefactId}`);
  }
  if (!input.relevant && input.placement !== "na") {
    throw new RatingError("an item marked not relevant has placement na");
  }
  return insertFixRating(db, {
    runId: sample.runId,
    sampleArtefactId: sample.artefactId,
    itemId: input.itemId,
    rater: input.rater,
    raterName: input.raterName.trim(),
    relevant: input.relevant,
    placement: input.placement,
  });
}

/** The sample's precision@k and agreement from every rating row so far. */
export async function ratingSummaryOf(
  db: Queryable,
  sample: StoredRatingSample,
): Promise<RatingSummary> {
  const [rows, run] = await Promise.all([
    listFixRatings(db, sample.artefactId),
    getRun(db, sample.runId),
  ]);
  return summariseRatings(sample.items, rows, makeConfig(run?.config ?? {}));
}
