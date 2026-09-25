/**
 * Counterfactual engine: simulate each fix candidate on a copy of the prominence-weighted graph
 * (warm-started PageRank, depth from the home page) in parallel worker threads.
 */
export { resolveWorkers, simulateInWorkers, type PoolRun } from "./pool.js";
export type { TimedResult } from "./protocol.js";
export * from "./run.js";
export * from "./rescue.js";
