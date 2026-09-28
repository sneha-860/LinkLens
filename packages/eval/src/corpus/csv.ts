/**
 * Tidy CSV (RFC 4180): a header row, then one row per observation, CRLF line ends. The column
 * lists are the contract with analysis/ (linklens_analysis/corpus.py checks the same names).
 */
export const METRICS_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_id",
  "policy",
  "policy_version",
  "is_audit_policy",
  "metric",
  "value",
] as const;

/** E1: one row per site × pair of policies (a before b in P0–P5 order) × metric. */
export const POLICY_PAIRS_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_id",
  "policy_a",
  "policy_b",
  "top_k",
  "metric",
  "value",
] as const;

/** E2: one row per site × discovery channel × metric (channel "all": the site's totals). */
export const CHANNELS_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_id",
  "policy",
  "policy_version",
  "channel",
  "metric",
  "value",
] as const;

/**
 * E3: one row per site × k × method × metric. Site-level values (targets, pool) have method
 * "site" and an empty k.
 */
export const E3_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_id",
  "policy",
  "policy_version",
  "k",
  "method",
  "metric",
  "value",
] as const;

/**
 * E4: one row per site × comparison × metric. Comparison "pages" holds the page classes and
 * shares; the others (observed, siteChange, samePages, coverageA, coverageB) the audit metrics.
 */
export const E4_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_a",
  "run_b",
  "comparison",
  "metric",
  "value",
] as const;

/** E4: every page crawled in either run, with its class. */
export const E4_PAGES_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "node",
  "status",
  "cause",
  "reason",
] as const;

/** E5: one row per site × policy (P0 and the audit's) × metric. */
export const E5_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_id",
  "policy",
  "policy_version",
  "metric",
  "value",
] as const;

/** E5: every disagreement category, explained (examples joined by " | "). */
export const E5_CATEGORIES_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "policy",
  "kind",
  "category",
  "count",
  "share",
  "large",
  "explanation",
  "examples",
] as const;

/** E5: every disagreement, with its evidence (JSON). */
export const E5_DISAGREEMENTS_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "policy",
  "kind",
  "node",
  "category",
  "detail",
] as const;

/**
 * E6: one row per site × repeat × method × metric (recall@k, mrr, auc, queries). Method
 * "masking" holds the repeat's share, eligible pairs, masked links, targets and queries.
 */
export const E6_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_id",
  "policy",
  "repeat",
  "seed",
  "method",
  "metric",
  "value",
] as const;

/**
 * E7: one row per site × setting (σ, ε, α) × metric. `sweeps` lists the sweeps the setting is
 * in ("sigma|epsilon|alpha").
 */
export const E7_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_id",
  "policy",
  "sigma",
  "epsilon",
  "alpha",
  "scoring",
  "is_default",
  "sweeps",
  "metric",
  "value",
] as const;

/** E7: the top-k Jaccard between every pair of σ variants (default ε and α), per site. */
export const E7_SIGMA_PAIRS_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_id",
  "sigma_a",
  "sigma_b",
  "k",
  "jaccard",
] as const;

export const SITES_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "url",
  "notes",
  "status",
  "run_id",
  "attempts",
  "audit_policy",
  "pages_fetched",
  "fetches",
  "started_at",
  "finished_at",
  "duration_s",
  "commit",
  "model_sha256",
  "error",
] as const;

export const STAGES_COLUMNS = [
  "batch_id",
  "site_id",
  "architecture_class",
  "run_id",
  "stage",
  "position",
  "status",
  "duration_ms",
] as const;

export type Cell = string | number | boolean | null | undefined;

/** One field: quoted when it holds a comma, quote, CR or LF; null/undefined are empty. */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<C extends string>(
  columns: readonly C[],
  rows: readonly Readonly<Record<C, Cell>>[],
): string {
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
