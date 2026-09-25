import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import {
  insertAnalyticsClicks,
  insertArtefact,
  listAnalyticsClicks,
  listLinkObservations,
} from "../db/queries.js";
import type { AnalyticsClickRow, ArtefactRow, Json, Queryable } from "../db/types.js";
import { buildLinkGraph } from "../graph/build.js";
import { loadRunGraphInputs } from "../graph/derive.js";
import { makeInternalTest } from "../graph/scope.js";
import { parseAnalyticsCsv } from "./csv.js";
import { computeProminence, type NodeClicks, type PageLinks, type Prominence } from "./weights.js";

export const PROMINENCE_ARTEFACT = "prominence";

/**
 * Map analytics rows to policy nodes with the same policy (and context) as the link graph.
 * A URL that cannot be parsed or is outside the crawl scope is kept with a null node.
 */
export function mapClicks(
  rows: readonly Pick<AnalyticsClickRow, "sourceUrl" | "targetUrl" | "clicks">[],
  isInternal: (url: string) => boolean,
  canonicalise: (url: string) => string,
): NodeClicks[] {
  const node = (url: string): { node: string | null; reason?: NodeClicks["reason"] } => {
    if (!URL.canParse(url)) return { node: null, reason: "invalid-url" };
    if (!isInternal(url)) return { node: null, reason: "external" };
    try {
      return { node: canonicalise(url) };
    } catch {
      return { node: null, reason: "invalid-url" };
    }
  };
  return rows.map((r) => {
    const s = node(r.sourceUrl);
    const t = node(r.targetUrl);
    const reason = s.reason ?? t.reason;
    return {
      source: s.node,
      target: t.node,
      clicks: r.clicks,
      ...(reason === undefined ? {} : { reason }),
    };
  });
}

/**
 * Parse an analytics CSV (source_url, target_url, clicks) and store its rows raw for `runId`.
 * Nothing is stored if any row is invalid (a CsvError lists every problem).
 */
export async function importAnalyticsCsv(
  db: Queryable,
  runId: number,
  csv: string,
  sourceDocument: string | null = null,
): Promise<AnalyticsClickRow[]> {
  const rows = parseAnalyticsCsv(csv);
  if (rows.length === 0) return [];
  return insertAnalyticsClicks(
    db,
    rows.map((r) => ({ runId, ...r, sourceDocument })),
  );
}

export interface PersistedProminence extends RunProminence {
  readonly artefact: ArtefactRow;
}

export interface RunProminence extends Prominence {
  readonly runId: number;
  readonly policyVersion: string;
}

/**
 * Prominence of every edge of the run's graph under `policyId` (the run's stored config), with
 * the run's imported analytics clicks when there are any. Nothing is written.
 */
export async function loadProminence(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<RunProminence> {
  const { observations, context, config } = await loadRunGraphInputs(db, runId);
  const policy = POLICIES[policyId];
  const canonicalise = (url: string) => policy.canonicalise(url, context);
  const isInternal = makeInternalTest(observations.seedUrl, config.includeSubdomains);
  const { graph } = buildLinkGraph({
    seedUrl: observations.seedUrl,
    pages: observations.pages,
    links: observations.links,
    isInternal,
    canonicalise,
  });

  const [rows, clicks] = await Promise.all([
    listLinkObservations(db, runId),
    listAnalyticsClicks(db, runId),
  ]);
  const byFetch = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byFetch.get(r.sourceFetchId);
    if (list === undefined) byFetch.set(r.sourceFetchId, [r]);
    else list.push(r);
  }

  const pages: PageLinks[] = [];
  graph.forEachNode((node, a) => {
    if (a.representativeFetchId === null) return;
    pages.push({
      node,
      links: (byFetch.get(a.representativeFetchId) ?? []).map((r) => {
        const edge = `obs:${r.id}`;
        return {
          observationId: r.id,
          domRegion: r.domRegion,
          templateSignature: r.templateSignature,
          positionIndex: r.positionIndex,
          target: graph.hasEdge(edge) ? graph.target(edge) : null,
        };
      }),
    });
  });

  const prominence = computeProminence(
    { pages, analytics: mapClicks(clicks, isInternal, canonicalise) },
    config,
  );
  return { ...prominence, runId, policyVersion: policy.version };
}

/** loadProminence, appended as a `prominence` artefact. */
export async function buildProminenceRun(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<PersistedProminence> {
  const result = await loadProminence(db, runId, policyId);
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion: result.policyVersion,
    kind: PROMINENCE_ARTEFACT,
    payload: result as unknown as Json,
  });
  return { ...result, artefact };
}
