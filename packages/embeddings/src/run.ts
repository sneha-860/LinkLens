import { db as q, semantic, text, type canonicalise, type db } from "@linklens/core";
import type { Embedder, EmbedResult } from "./options.js";

export interface PersistedCosineMatrix extends semantic.CosineMatrix {
  readonly artefact: db.ArtefactRow;
  /** Cache statistics of this run (not stored: they depend on the cache, not the data). */
  readonly cache: Pick<EmbedResult, "hits" | "misses">;
}

/**
 * Embed every document of a run under `policyId` (the same representative pages as the text
 * representation), compute cos(u, v) for all pairs and append a `cosine-matrix` artefact.
 * The embedder must use the run's stored embedding settings (model, dtype, body tokens).
 */
export async function buildCosineRun(
  database: db.Queryable,
  runId: number,
  policyId: canonicalise.PolicyId,
  embedder: Embedder,
): Promise<PersistedCosineMatrix> {
  const { documents, policyVersion, config } = await text.loadRunDocuments(
    database,
    runId,
    policyId,
  );
  const o = embedder.options;
  if (
    o.model !== config.embeddingModel ||
    o.dtype !== config.embeddingDtype ||
    o.bodyTokens !== config.embeddingBodyTokens
  ) {
    throw new Error(
      `embedder (${o.model}, ${o.dtype}, ${o.bodyTokens} tokens) does not match run ${runId}'s ` +
        `config (${config.embeddingModel}, ${config.embeddingDtype}, ${config.embeddingBodyTokens})`,
    );
  }

  const inputs = documents
    .map(semantic.embeddingInput)
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  const result = await embedder.embed(inputs.map(({ title, body }) => ({ title, body })));
  const matrix: semantic.CosineMatrix = {
    version: semantic.COSINE_VERSION,
    runId,
    policyVersion,
    model: o.model,
    dtype: o.dtype,
    bodyTokens: o.bodyTokens,
    dimensions: result.dimensions,
    nodes: inputs.map((x) => x.node),
    contentKeys: result.keys,
    upper: [...semantic.cosineUpper(result.vectors)],
  };
  const artefact = await q.insertArtefact(database, {
    runId,
    policyVersion,
    kind: semantic.COSINE_ARTEFACT,
    payload: matrix as unknown as db.Json,
  });
  return { ...matrix, artefact, cache: { hits: result.hits, misses: result.misses } };
}
