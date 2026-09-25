/**
 * Link graph over canonical nodes and its metrics: PageRank, BFS depth, SCC, betweenness,
 * in/out degree, reachability. Built with graphology; algorithms are implemented here so that
 * iteration order, dangling-node handling and sampling are explicit and deterministic.
 */
export * from "./build.js";
export * from "./metrics.js";
export * from "./derive.js";
export * from "./random.js";
export * from "./scope.js";
