import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import { insertArtefact, listArtefacts, listFetchBodies, listPages } from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import { deriveGraphFromObservations, loadRunGraphInputs } from "../graph/derive.js";
import {
  IMPORTANCE_ARTEFACT,
  IMPORTANCE_VERSION,
  computeImportance,
  type PageImportance,
} from "./importance.js";
import { schemaTypes } from "./schema.js";

/** Bodies read per query, so a large run never holds every page's HTML at once. */
const BODY_BATCH = 100;

/** schema.org types of these fetches' stored HTML (a fetch without a stored body has none). */
export async function loadSchemaTypes(
  db: Queryable,
  runId: number,
  fetchIds: readonly number[],
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const decoder = new TextDecoder("utf-8");
  const ids = [...new Set(fetchIds)].sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i += BODY_BATCH) {
    for (const row of await listFetchBodies(db, runId, ids.slice(i, i + BODY_BATCH))) {
      out.set(row.fetchId, schemaTypes(decoder.decode(row.body)));
    }
  }
  return out;
}

/**
 * Page type and importance of every node of the run's graph under `policyId` (the run's stored
 * config), computed in memory: nothing is written.
 */
export async function loadImportance(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<PageImportance> {
  const [{ observations, context, config }, pages] = await Promise.all([
    loadRunGraphInputs(db, runId),
    listPages(db, runId, "crawl"),
  ]);
  const { graph, summary } = deriveGraphFromObservations(observations, policyId, context, config);
  const representative: number[] = [];
  graph.forEachNode((_n, a) => {
    if (a.representativeFetchId !== null) representative.push(a.representativeFetchId);
  });
  const schema = await loadSchemaTypes(db, runId, representative);
  const body = new Map(pages.map((p) => [p.fetchId, p.bodyText]));
  return computeImportance(
    {
      runId,
      policyVersion: POLICIES[policyId].version,
      graph,
      seedNode: summary.seedNode,
      bodyText: (id) => body.get(id) ?? null,
      schemaTypes: (id) => schema.get(id) ?? [],
    },
    config,
  );
}

export interface PersistedImportance extends PageImportance {
  readonly artefact: ArtefactRow;
}

/** loadImportance, appended as a `page-importance` artefact. */
export async function buildImportanceRun(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<PersistedImportance> {
  const importance = await loadImportance(db, runId, policyId);
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion: importance.policyVersion,
    kind: IMPORTANCE_ARTEFACT,
    payload: importance as unknown as Json,
  });
  return { ...importance, artefact };
}

/**
 * The run's latest `page-importance` artefact of the current version under `policyId`, or a new
 * one (computed and appended) when there is none.
 */
export async function importanceFor(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<PageImportance> {
  const rows = await listArtefacts(db, runId, {
    kind: IMPORTANCE_ARTEFACT,
    policyVersion: POLICIES[policyId].version,
  });
  const stored = rows
    .map((r) => r.payload as unknown as PageImportance)
    .filter((p) => p.version === IMPORTANCE_VERSION)
    .at(-1);
  return stored ?? buildImportanceRun(db, runId, policyId);
}
