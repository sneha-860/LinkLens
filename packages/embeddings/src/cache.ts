import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbedRequest, EmbeddingOptions } from "./options.js";

/**
 * Bump when the input assembly (truncation, joining) or pooling changes, so old cache entries
 * are never reused for a different computation.
 */
export const EMBEDDING_CACHE_VERSION = 1;
export const POOLING = "mean";
export const NORMALIZE = true;

/**
 * Cache key: SHA-256 over the model, its settings and the page content. Any change to either
 * gives a new key; the same content always gets the same key (reproducible re-runs).
 */
export function cacheKey(
  options: Pick<EmbeddingOptions, "model" | "dtype" | "bodyTokens">,
  request: EmbedRequest,
): string {
  const material = JSON.stringify([
    EMBEDDING_CACHE_VERSION,
    options.model,
    options.dtype,
    POOLING,
    NORMALIZE,
    options.bodyTokens,
    request.title,
    request.body,
  ]);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** A model id as one safe path segment ("Xenova/all-MiniLM-L6-v2" → "Xenova__all-MiniLM-L6-v2"). */
export const modelSlug = (model: string) => model.replace(/[^A-Za-z0-9._-]+/g, "__");

/**
 * One file per embedding: `<root>/embeddings/<model>/<dtype>/<key[0..2]>/<key>.f32`, raw
 * little-endian float32. Writes go to a temporary file first and are renamed into place, so a
 * reader never sees a partial vector.
 */
export class EmbeddingCache {
  constructor(
    private readonly root: string,
    private readonly options: Pick<EmbeddingOptions, "model" | "dtype">,
  ) {}

  path(key: string): string {
    return join(
      this.root,
      "embeddings",
      modelSlug(this.options.model),
      this.options.dtype,
      key.slice(0, 2),
      `${key}.f32`,
    );
  }

  /** The cached vector, or null if absent or unreadable. */
  async get(key: string, dimensions?: number): Promise<Float32Array | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path(key));
    } catch {
      return null;
    }
    if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
    if (dimensions !== undefined && bytes.length !== dimensions * 4) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(bytes.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }

  async set(key: string, vector: Float32Array): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const bytes = Buffer.alloc(vector.length * 4);
    for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i] as number, i * 4);
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }
}
