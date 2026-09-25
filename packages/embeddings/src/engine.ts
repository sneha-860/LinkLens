import { join } from "node:path";
import { cacheKey, EmbeddingCache, NORMALIZE, POOLING } from "./cache.js";
import type { EmbedRequest, EmbedResult, Embedder, EmbeddingOptions } from "./options.js";

/** The slice of a transformers.js feature-extraction pipeline that the engine uses. */
export interface Extractor {
  (
    texts: string[],
    options: { pooling: typeof POOLING; normalize: boolean },
  ): Promise<{ dims: number[]; data: ArrayLike<number> }>;
  tokenizer: {
    encode(text: string, options: { add_special_tokens: boolean }): number[];
    decode(ids: number[], options: { skip_special_tokens: boolean }): string;
  };
}

export type ExtractorLoader = (options: EmbeddingOptions) => Promise<Extractor>;

/** Loads the model with transformers.js (imported lazily: only where the engine runs). */
export const loadTransformersExtractor: ExtractorLoader = async (options) => {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = options.modelDir ?? join(options.cacheDir, "models");
  const extractor = await pipeline("feature-extraction", options.model, { dtype: options.dtype });
  return extractor as unknown as Extractor;
};

/**
 * Embeds pages as Title + the first `bodyTokens` model tokens of the body, mean-pooled and
 * L2-normalised, through an on-disk cache. The model is loaded on the first cache miss only, so
 * a fully cached re-run never loads it.
 */
export class EmbeddingEngine implements Embedder {
  private extractor: Promise<Extractor> | null = null;
  private readonly cache: EmbeddingCache;

  constructor(
    readonly options: EmbeddingOptions,
    private readonly load: ExtractorLoader = loadTransformersExtractor,
  ) {
    this.cache = new EmbeddingCache(options.cacheDir, options);
  }

  private model(): Promise<Extractor> {
    this.extractor ??= this.load(this.options).catch((e: unknown) => {
      this.extractor = null;
      throw e;
    });
    return this.extractor;
  }

  /** The text actually embedded: title, then the body cut to its first `bodyTokens` tokens. */
  static inputText(extractor: Extractor, request: EmbedRequest, bodyTokens: number): string {
    const ids = extractor.tokenizer.encode(request.body, { add_special_tokens: false });
    const body =
      ids.length <= bodyTokens
        ? request.body
        : extractor.tokenizer.decode(ids.slice(0, bodyTokens), { skip_special_tokens: true });
    return [request.title, body].filter((s) => s.trim() !== "").join("\n");
  }

  async embed(requests: readonly EmbedRequest[]): Promise<EmbedResult> {
    const keys = requests.map((r) => cacheKey(this.options, r));
    const vectors: (Float32Array | null)[] = await Promise.all(keys.map((k) => this.cache.get(k)));
    const missing = [...vectors.keys()].filter((i) => vectors[i] === null);
    // Identical requests share a key: compute each distinct key once.
    const todo = [...new Map(missing.map((i) => [keys[i] as string, i])).values()];

    const computed = new Map<string, Float32Array>();
    if (todo.length > 0) {
      const extractor = await this.model();
      for (let b = 0; b < todo.length; b += this.options.batchSize) {
        const batch = todo.slice(b, b + this.options.batchSize);
        const texts = batch.map((i) =>
          EmbeddingEngine.inputText(
            extractor,
            requests[i] as EmbedRequest,
            this.options.bodyTokens,
          ),
        );
        const out = await extractor(texts, { pooling: POOLING, normalize: NORMALIZE });
        const dim = out.dims[out.dims.length - 1] as number;
        for (const [row, i] of batch.entries()) {
          // A copy per vector, so each owns its buffer (transferable from the worker).
          const v = Float32Array.from({ length: dim }, (_, k) => out.data[row * dim + k] as number);
          computed.set(keys[i] as string, v);
          await this.cache.set(keys[i] as string, v);
        }
      }
      for (const i of missing) vectors[i] = computed.get(keys[i] as string) ?? null;
    }

    const done = vectors.map((v) => v as Float32Array);
    const dims = new Set(done.map((v) => v.length));
    if (dims.size > 1) throw new Error(`embeddings of different sizes: ${[...dims].join(", ")}`);
    return {
      vectors: done,
      keys,
      dimensions: done[0]?.length ?? 0,
      hits: requests.length - missing.length,
      misses: missing.length,
    };
  }
}
