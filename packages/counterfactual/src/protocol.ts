import type { fixes } from "@linklens/core";

/** Sent once to each worker: the graph and baseline every scenario is compared with. */
export interface WorkerInit {
  readonly graph: fixes.WeightedGraph;
  readonly baseline: fixes.Baseline;
  readonly bodyWeight: number;
  readonly params: fixes.PageRankParams;
  /** Set when running from TypeScript sources: the module the bootstrap loads. */
  readonly entry?: string;
}

export interface ChunkMessage {
  readonly chunk: number;
  readonly scenarios: readonly fixes.Scenario[];
}

export interface TimedResult extends fixes.CounterfactualResult {
  /** Wall-clock time of this candidate's simulation (graph copy, PageRank, BFS), in ms. */
  readonly runtimeMs: number;
}

export type ChunkReply =
  | { readonly chunk: number; readonly ok: true; readonly results: TimedResult[] }
  | { readonly chunk: number; readonly ok: false; readonly error: string };
