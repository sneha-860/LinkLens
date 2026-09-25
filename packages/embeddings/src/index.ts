/**
 * Semantic engine: sentence embeddings with transformers.js (config.embeddingModel), mean-pooled
 * and L2-normalised, cached on disk by content hash and model, computed in a worker thread.
 */
export * from "./options.js";
export * from "./cache.js";
export {
  EmbeddingEngine,
  loadTransformersExtractor,
  type Extractor,
  type ExtractorLoader,
} from "./engine.js";
export { EmbeddingWorker } from "./client.js";
export * from "./run.js";
