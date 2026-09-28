import type { LinkLensConfig } from "../config.js";
import type { FixRatingRow, Placement, Rater } from "../db/types.js";
import { mulberry32, sampleWithoutReplacement } from "../graph/random.js";
import type { AnchorResult } from "../fixes/anchor.js";
import type { CandidateAction } from "../fixes/candidates.js";
import { topK, type FixRecord } from "../fixes/scoring.js";

/** Bump whenever the sample or the summary can change. */
export const RATING_VERSION = "rating@1.0.0";
export const RATING_SAMPLE_ARTEFACT = "rating-sample";

/**
 * E8 human rating in the dashboard: a blind sample of top fixes (no score, rank, ΔPR, REF or σ
 * is shown), two raters (A and B) marking each relevant / not relevant and the placement
 * quality of its suggested paragraph and anchor (good / acceptable / poor, or n/a).
 */

/** What a rater sees: the pages, the action and the suggested placement. */
export interface BlindItem {
  readonly itemId: string;
  /** Display order, 1…n (seeded random, not the rank). */
  readonly position: number;
  readonly donor: string;
  readonly target: string;
  readonly donorTitle: string | null;
  readonly targetTitle: string | null;
  readonly action: CandidateAction;
  /** The suggested paragraph and anchor (null: none computed); the "none" case says why. */
  readonly placement: AnchorResult | null;
}

/** A sampled item as stored: the blind fields plus its global rank (never sent to raters). */
export interface SampleItem extends BlindItem {
  readonly rank: number;
}

export interface RatingSample {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly sigmaVariant: string;
  readonly sources: {
    readonly fixRankingArtefactId: number;
    readonly explanationsArtefactId: number | null;
  };
  readonly pool: number;
  readonly size: number;
  readonly seed: number;
  readonly items: SampleItem[];
}

export interface SampleContext {
  readonly title: (node: string) => string | null;
  readonly placement: (fixId: string) => AnchorResult | null;
}

/**
 * Pure: `size` fixes drawn (seeded) from the top `pool` by global rank, in the drawn order, so
 * the display order says nothing about the rank. With pool = size, every top fix is rated.
 */
export function sampleForRating(
  fixes: readonly FixRecord[],
  context: SampleContext,
  options: { readonly pool: number; readonly size: number; readonly seed: number },
): SampleItem[] {
  const pool = topK(fixes, options.pool);
  const drawn = sampleWithoutReplacement(pool, options.size, mulberry32(options.seed));
  return drawn.map((f, i) => ({
    itemId: f.id,
    position: i + 1,
    donor: f.donor,
    target: f.target,
    donorTitle: context.title(f.donor),
    targetTitle: context.title(f.target),
    action: f.type,
    placement: context.placement(f.id),
    rank: f.rank,
  }));
}

/** The blind view of a sample's items (the rank dropped), in display order. */
export function blindItems(items: readonly SampleItem[]): BlindItem[] {
  return [...items]
    .sort((a, b) => a.position - b.position)
    .map(({ rank: _rank, ...blind }) => blind);
}

// ---------- answers and agreement ----------

export interface Answer {
  readonly relevant: boolean;
  readonly placement: Placement;
  readonly raterName: string;
  readonly ratedAt: Date | string;
}

/** The latest answer per rater and item (rows are append-only; later rows win). */
export function latestAnswers(
  rows: readonly Pick<
    FixRatingRow,
    "id" | "itemId" | "rater" | "relevant" | "placement" | "raterName" | "ratedAt"
  >[],
): Map<Rater, Map<string, Answer>> {
  const out = new Map<Rater, Map<string, Answer>>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    let m = out.get(r.rater);
    if (m === undefined) out.set(r.rater, (m = new Map()));
    m.set(r.itemId, {
      relevant: r.relevant,
      placement: r.placement,
      raterName: r.raterName,
      ratedAt: r.ratedAt,
    });
  }
  return out;
}

/**
 * Cohen's kappa of two raters' labels on the same items: (p_o − p_e) / (1 − p_e), p_e from each
 * rater's marginals. Null without items or when p_e = 1 (both gave one and the same label).
 */
export function cohensKappa<T>(a: readonly T[], b: readonly T[]): number | null {
  if (a.length !== b.length) throw new Error("cohensKappa: label lists differ in length");
  const n = a.length;
  if (n === 0) return null;
  const labels = [...new Set([...a, ...b])];
  let agree = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree += 1;
  const po = agree / n;
  let pe = 0;
  for (const l of labels) {
    pe += (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n);
  }
  return pe >= 1 ? null : (po - pe) / (1 - pe);
}

/**
 * Weighted kappa for ordinal labels (`order`, best first) with linear weights |i − j| / (k − 1):
 * 1 − Σ w·observed / Σ w·expected. Null without items or when no disagreement is expected.
 */
export function weightedKappa<T>(
  a: readonly T[],
  b: readonly T[],
  order: readonly T[],
): number | null {
  if (a.length !== b.length) throw new Error("weightedKappa: label lists differ in length");
  const n = a.length;
  const k = order.length;
  if (n === 0 || k < 2) return null;
  const idx = (x: T) => {
    const i = order.indexOf(x);
    if (i < 0) throw new Error(`weightedKappa: ${String(x)} is not an ordered label`);
    return i;
  };
  const w = (i: number, j: number) => Math.abs(i - j) / (k - 1);
  const ra = new Array<number>(k).fill(0);
  const rb = new Array<number>(k).fill(0);
  let observed = 0;
  for (let i = 0; i < n; i++) {
    const x = idx(a[i] as T);
    const y = idx(b[i] as T);
    ra[x] = (ra[x] as number) + 1;
    rb[y] = (rb[y] as number) + 1;
    observed += w(x, y);
  }
  let expected = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) expected += (w(i, j) * ((ra[i] as number) * (rb[j] as number))) / n;
  }
  return expected === 0 ? null : 1 - observed / expected;
}

export interface PrecisionAtK {
  readonly k: number;
  /** Sampled items with rank ≤ k that were rated (all of the top k when pool = size). */
  readonly rated: number;
  readonly relevant: number;
  readonly precision: number | null;
}

/** Precision@k over the rated sampled items with rank ≤ k. */
export function precisionAtK(
  items: readonly Pick<SampleItem, "itemId" | "rank">[],
  relevant: (itemId: string) => boolean | undefined,
  ks: readonly number[],
): PrecisionAtK[] {
  return [...ks]
    .sort((a, b) => a - b)
    .map((k) => {
      const answers = items
        .filter((i) => i.rank <= k)
        .map((i) => relevant(i.itemId))
        .filter((x): x is boolean => x !== undefined);
      const yes = answers.filter((x) => x).length;
      return {
        k,
        rated: answers.length,
        relevant: yes,
        precision: answers.length === 0 ? null : yes / answers.length,
      };
    });
}

/** Placement labels from best to worst (n/a is not on the scale). */
export const PLACEMENT_ORDER: readonly Placement[] = ["good", "acceptable", "poor"];

export interface RaterSummary {
  readonly rater: Rater;
  readonly name: string | null;
  readonly rated: number;
  readonly relevant: number;
  readonly precisionAtK: PrecisionAtK[];
  readonly placement: Record<Placement, number>;
}

export interface RatingSummary {
  readonly version: string;
  readonly items: number;
  readonly ks: number[];
  readonly raters: RaterSummary[];
  /**
   * Both raters together: precision@k where an item counts as relevant only when both said so
   * (strict), and the mean of the two raters' precision@k.
   */
  readonly consensus: {
    readonly strict: PrecisionAtK[];
    readonly mean: { readonly k: number; readonly precision: number | null }[];
  };
  readonly agreement: {
    /** Items both raters rated. */
    readonly items: number;
    readonly relevance: { readonly observed: number | null; readonly kappa: number | null };
    /** Over items both marked relevant with a placement on the scale (not n/a). */
    readonly placement: {
      readonly items: number;
      readonly observed: number | null;
      readonly kappa: number | null;
      readonly weightedKappa: number | null;
    };
  };
}

/** Pure: precision@k per rater and together, and the raters' agreement (Cohen's kappa). */
export function summariseRatings(
  items: readonly Pick<SampleItem, "itemId" | "rank">[],
  rows: Parameters<typeof latestAnswers>[0],
  config: Pick<LinkLensConfig, "ratingKs">,
): RatingSummary {
  const answers = latestAnswers(rows);
  const inSample = new Set(items.map((i) => i.itemId));
  const ks = [...config.ratingKs].sort((a, b) => a - b);
  const of = (r: Rater) => answers.get(r) ?? new Map<string, Answer>();
  const raters = (["A", "B"] as const).map((rater): RaterSummary => {
    const m = of(rater);
    const mine = [...m].filter(([id]) => inSample.has(id)).map(([, a]) => a);
    const placement = { good: 0, acceptable: 0, poor: 0, na: 0 } as Record<Placement, number>;
    for (const a of mine) placement[a.placement] += 1;
    return {
      rater,
      name: mine.at(-1)?.raterName ?? [...m.values()].at(-1)?.raterName ?? null,
      rated: mine.length,
      relevant: mine.filter((a) => a.relevant).length,
      precisionAtK: precisionAtK(items, (id) => m.get(id)?.relevant, ks),
      placement,
    };
  });

  const a = of("A");
  const b = of("B");
  const both = items.filter((i) => a.has(i.itemId) && b.has(i.itemId)).map((i) => i.itemId);
  const relA = both.map((id) => (a.get(id) as Answer).relevant);
  const relB = both.map((id) => (b.get(id) as Answer).relevant);
  const placed = both.filter((id) => {
    const x = a.get(id) as Answer;
    const y = b.get(id) as Answer;
    return x.relevant && y.relevant && x.placement !== "na" && y.placement !== "na";
  });
  const plA = placed.map((id) => (a.get(id) as Answer).placement);
  const plB = placed.map((id) => (b.get(id) as Answer).placement);
  const observed = <T>(x: readonly T[], y: readonly T[]) =>
    x.length === 0 ? null : x.filter((v, i) => v === y[i]).length / x.length;
  const strict = precisionAtK(
    items.filter((i) => a.has(i.itemId) && b.has(i.itemId)),
    (id) => (a.get(id) as Answer).relevant && (b.get(id) as Answer).relevant,
    ks,
  );
  const mean = ks.map((k, i) => {
    const pa = raters[0]?.precisionAtK[i]?.precision ?? null;
    const pb = raters[1]?.precisionAtK[i]?.precision ?? null;
    return { k, precision: pa === null || pb === null ? null : (pa + pb) / 2 };
  });
  return {
    version: RATING_VERSION,
    items: items.length,
    ks,
    raters,
    consensus: { strict, mean },
    agreement: {
      items: both.length,
      relevance: { observed: observed(relA, relB), kappa: cohensKappa(relA, relB) },
      placement: {
        items: placed.length,
        observed: observed(plA, plB),
        kappa: cohensKappa(plA, plB),
        weightedKappa: weightedKappa(plA, plB, PLACEMENT_ORDER),
      },
    },
  };
}
