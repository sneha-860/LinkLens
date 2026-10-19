import type { PolicyId } from "../canonicalise/index.js";
import type { LinkLensConfig } from "../config.js";
import type { Queryable } from "../db/types.js";
import { deriveGraphFromObservations, loadRunGraphInputs } from "../graph/derive.js";
import { importanceFor } from "../importance/run.js";
import { targetWeights } from "../semantic/ref.js";
import { loadRunDocuments, loadTextModel } from "../text/run.js";
import type { RawDocument } from "../text/model.js";
import {
  fixFeatureRows,
  graphLinks,
  nodeFacts,
  type FixFeatureRow,
  type NodeFacts,
} from "./features.js";
import type { FixRecord } from "./scoring.js";

/**
 * The feature rows of a stored ranking's fixes, in the unmasked site (the run's stored config):
 * its graph (PageRank, depth, neighbours, SCC), page importance (the stored `page-importance`
 * artefact, or built), and text model (Jaccard of the donor and target views). Nothing else is
 * written. The learnedScore stage sends these to the ranker.
 */
export async function loadFixFeatureRows(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
  ranked: readonly FixRecord[],
): Promise<{ rows: FixFeatureRow[]; config: Readonly<LinkLensConfig> }> {
  const [{ observations, context, config }, imp, { model }] = await Promise.all([
    loadRunGraphInputs(db, runId),
    importanceFor(db, runId, policyId),
    loadTextModel(db, runId, policyId),
  ]);
  const { graph } = deriveGraphFromObservations(observations, policyId, context, config);
  const rows = fixFeatureRows(
    ranked,
    {
      facts: nodeFacts(graph, imp.nodes),
      donorTerms: new Map(model.documents.map((d) => [d.node, new Set(d.donor)])),
      targetTerms: new Map(model.documents.map((d) => [d.node, new Set(targetWeights(d).keys())])),
    },
    config,
  );
  return { rows, config };
}

/** What the graphsageScore stage needs to build the site graph (embeddings aside). */
export interface SiteGraphInputs {
  /** The pages with text (raw documents, for the embedder), in node order. */
  readonly documents: RawDocument[];
  readonly links: { source: string; target: string; domRegion: string | null }[];
  readonly facts: (node: string) => NodeFacts | undefined;
  readonly config: Readonly<LinkLensConfig>;
}

/**
 * The unmasked site's GraphSAGE inputs: the documents (nodes), the policy graph's links and each
 * node's facts, as `l13 graph-export` builds its "full" graph for training.
 */
export async function loadSiteGraphInputs(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<SiteGraphInputs> {
  const [{ observations, context, config }, imp, { documents }] = await Promise.all([
    loadRunGraphInputs(db, runId),
    importanceFor(db, runId, policyId),
    loadRunDocuments(db, runId, policyId),
  ]);
  const { graph } = deriveGraphFromObservations(observations, policyId, context, config);
  return { documents, links: graphLinks(graph), facts: nodeFacts(graph, imp.nodes), config };
}
