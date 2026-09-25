/**
 * Typed row shapes and query helpers for the LinkLens schema (see packages/db/migrations).
 * Helpers take an injected `Queryable`; this module never opens connections itself.
 * Append-only tables (link_observations, discovery_observations) expose insert and list only.
 */
export * from "./types.js";
export * from "./queries.js";
export { buildInsert, PG_MAX_PARAMS, type ColumnSpec, type Statement } from "./sql.js";
