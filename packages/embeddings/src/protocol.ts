import type { EmbedRequest, EmbedResult, EmbeddingOptions } from "./options.js";

/** Passed to the worker as workerData. */
export interface WorkerInit {
  readonly options: EmbeddingOptions;
  /** Set by the client when running from TypeScript sources: the module the bootstrap loads. */
  readonly entry?: string;
}

export interface EmbedMessage {
  readonly id: number;
  readonly type: "embed";
  readonly requests: readonly EmbedRequest[];
}

export type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly result: EmbedResult }
  | { readonly id: number; readonly ok: false; readonly error: string };
