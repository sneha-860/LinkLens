/**
 * Page importance (L12): a rule-based page-type classifier (URL patterns, schema.org types,
 * structure) and importance(v) in [0, 1] from the type prior, PageRank percentile, depth and
 * inbound main-content links. Heuristic weights; used by the S_imp fix score only when asked.
 */
export * from "./schema.js";
export * from "./page-type.js";
export * from "./importance.js";
export * from "./run.js";
