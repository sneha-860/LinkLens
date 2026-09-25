/**
 * Discovery channels and their reconciliation: which URLs each channel found, which are
 * orphans (found only outside the link graph), and each channel's marginal yield.
 * Collection (fetching) lives in packages/crawler/src/discovery.
 */
export * from "./channels.js";
export * from "./reconcile.js";
