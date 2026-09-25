import type { EmbeddingDtype, LinkLensConfig } from "@linklens/core";

/** Everything that determines an embedding, plus where the cache lives. */
export interface EmbeddingOptions {
  /** transformers.js model id (config.embeddingModel). */
  readonly model: string;
  readonly dtype: EmbeddingDtype;
  /** The body is cut to its first this-many model tokens. */
  readonly bodyTokens: number;
  readonly batchSize: number;
  /**
   * Cache root: embeddings under `<cacheDir>/embeddings`, downloaded model files under
   * `<cacheDir>/models`.
   */
  readonly cacheDir: string;
  /** Where model files are downloaded; defaults to `<cacheDir>/models`. Not part of the key. */
  readonly modelDir?: string;
}

export function embeddingOptions(
  config: Pick<
    LinkLensConfig,
    "embeddingModel" | "embeddingDtype" | "embeddingBodyTokens" | "embeddingBatchSize"
  >,
  cacheDir: string,
): EmbeddingOptions {
  return {
    model: config.embeddingModel,
    dtype: config.embeddingDtype,
    bodyTokens: config.embeddingBodyTokens,
    batchSize: config.embeddingBatchSize,
    cacheDir,
  };
}

/** One page to embed (see core `embeddingInput`). */
export interface EmbedRequest {
  readonly title: string;
  readonly body: string;
}

export interface EmbedResult {
  /** L2-normalised mean-pooled embeddings, one per request, in order. */
  readonly vectors: Float32Array[];
  /** Cache key per request. */
  readonly keys: string[];
  readonly dimensions: number;
  /** Requests served from the cache / computed by the model. */
  readonly hits: number;
  readonly misses: number;
}

/** Anything that embeds pages: the in-thread engine or the worker client. */
export interface Embedder {
  readonly options: EmbeddingOptions;
  embed(requests: readonly EmbedRequest[]): Promise<EmbedResult>;
}
