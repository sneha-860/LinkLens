import { prominence, stats } from "@linklens/core";

/** A fix to rate (from a ranking and its explanations). */
export interface RatingItem {
  readonly id: string;
  readonly rank: number;
  readonly donor: string;
  readonly target: string;
  readonly type: string;
  readonly score: number;
  readonly explanation: string;
}

const field = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const RATING_COLUMNS = [
  "item_id",
  "rank",
  "donor",
  "target",
  "type",
  "score",
  "explanation",
  "rater",
  "relevance",
  "would_add",
] as const;

/**
 * E8: a rating sheet (CSV) for human raters, one row per fix. Raters fill `rater`, `relevance`
 * (1 = unrelated … 5 = clearly belongs) and `would_add` (yes/no). Items are in rank order.
 */
export function ratingSheet(items: readonly RatingItem[]): string {
  const lines = [RATING_COLUMNS.join(",")];
  for (const i of [...items].sort((a, b) => a.rank - b.rank)) {
    lines.push(
      [i.id, i.rank, i.donor, i.target, i.type, i.score, i.explanation, "", "", ""]
        .map(field)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export interface Rating {
  readonly itemId: string;
  readonly rank: number;
  readonly score: number;
  readonly rater: string;
  readonly relevance: number;
  readonly wouldAdd: boolean | null;
}

/** Filled sheets (one or several raters, concatenated or separate files): the rated rows. */
export function parseRatings(csv: string): Rating[] {
  const records = prominence.parseCsv(csv);
  const header = records[0]?.fields.map((f) => f.trim().toLowerCase()) ?? [];
  const at = (name: string) => header.indexOf(name);
  for (const c of ["item_id", "rater", "relevance"]) {
    if (at(c) < 0) throw new Error(`rating sheet: missing column ${c}`);
  }
  const out: Rating[] = [];
  for (const { fields, line } of records.slice(1)) {
    const get = (n: string) => (fields[at(n)] ?? "").trim();
    if (get("item_id") === "" || get("relevance") === "") continue;
    const relevance = Number(get("relevance"));
    if (!Number.isInteger(relevance) || relevance < 1 || relevance > 5) {
      throw new Error(
        `rating sheet line ${line}: relevance must be 1–5, got "${get("relevance")}"`,
      );
    }
    const w = get("would_add").toLowerCase();
    out.push({
      itemId: get("item_id"),
      rank: Number(get("rank")),
      score: Number(get("score")),
      rater: get("rater") || "anonymous",
      relevance,
      wouldAdd: w === "yes" || w === "y" ? true : w === "no" || w === "n" ? false : null,
    });
  }
  return out;
}

export interface RatingSummary {
  readonly ratings: number;
  readonly items: number;
  readonly raters: string[];
  readonly meanRelevance: number | null;
  /** Share of "yes" among answered would_add. */
  readonly wouldAddRate: number | null;
  /** Mean relevance of the top 10 ranks against the rest (does the ranking put good fixes first?). */
  readonly meanRelevanceTop10: number | null;
  readonly meanRelevanceRest: number | null;
  /** Spearman of the fix score against the item's mean relevance. */
  readonly scoreVsRelevance: number | null;
  /** Between raters, over items both rated: mean pairwise Spearman and exact-agreement rate. */
  readonly interRater: {
    readonly pairs: number;
    readonly spearman: number | null;
    readonly exactAgreement: number | null;
  };
}

export function summariseRatings(ratings: readonly Rating[]): RatingSummary {
  const byItem = new Map<string, Rating[]>();
  for (const r of ratings) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);
  const itemMean = new Map(
    [...byItem].map(([id, rs]) => [id, stats.mean(rs.map((r) => r.relevance)) as number]),
  );
  const first = new Map([...byItem].map(([id, rs]) => [id, rs[0] as Rating]));
  const raters = [...new Set(ratings.map((r) => r.rater))].sort();
  const answered = ratings.filter((r) => r.wouldAdd !== null);

  const spear: number[] = [];
  const exact: number[] = [];
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      const a = new Map(
        ratings.filter((r) => r.rater === raters[i]).map((r) => [r.itemId, r.relevance]),
      );
      const b = new Map(
        ratings.filter((r) => r.rater === raters[j]).map((r) => [r.itemId, r.relevance]),
      );
      const common = [...a.keys()].filter((k) => b.has(k));
      const s = stats.spearman(a, b);
      if (s !== null) spear.push(s);
      if (common.length > 0)
        exact.push(common.filter((k) => a.get(k) === b.get(k)).length / common.length);
    }
  }
  const top = [...itemMean]
    .filter(([id]) => (first.get(id)?.rank ?? Infinity) <= 10)
    .map(([, m]) => m);
  const rest = [...itemMean]
    .filter(([id]) => (first.get(id)?.rank ?? Infinity) > 10)
    .map(([, m]) => m);
  return {
    ratings: ratings.length,
    items: byItem.size,
    raters,
    meanRelevance: stats.mean(ratings.map((r) => r.relevance)),
    wouldAddRate:
      answered.length === 0 ? null : answered.filter((r) => r.wouldAdd).length / answered.length,
    meanRelevanceTop10: stats.mean(top),
    meanRelevanceRest: stats.mean(rest),
    scoreVsRelevance: stats.spearman(new Map([...first].map(([id, r]) => [id, r.score])), itemMean),
    interRater: {
      pairs: (raters.length * (raters.length - 1)) / 2,
      spearman: stats.mean(spear),
      exactAgreement: stats.mean(exact),
    },
  };
}
