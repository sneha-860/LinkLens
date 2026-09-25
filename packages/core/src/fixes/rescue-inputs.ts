import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import type { LinkLensConfig } from "../config.js";
import { listFetches, listPages } from "../db/queries.js";
import type { FetchRow, Queryable } from "../db/types.js";
import { loadReconciliation } from "../discovery/reconcile.js";
import { buildLinkGraph } from "../graph/build.js";
import { loadRunGraphInputs } from "../graph/derive.js";
import { makeInternalTest } from "../graph/scope.js";
import { loadProminence } from "../prominence/run.js";
import type { RefVariant } from "../semantic/ref.js";
import type { TextModel } from "../text/model.js";
import { loadTextModel } from "../text/run.js";
import { depthFromSeed, weightedGraph, type WeightedGraph } from "./counterfactual.js";
import type { OrphanInput } from "./rescue.js";

export interface RescueInputs {
  readonly policyVersion: string;
  readonly refVariant: RefVariant;
  readonly orphans: OrphanInput[];
  /** The site's text model (crawl pages only; orphans are scored against it, not added). */
  readonly model: TextModel;
  /**
   * The structural-prominence-weighted link graph, plus every orphan node it lacks (isolated),
   * so the counterfactual can add donor → orphan.
   */
  readonly graph: WeightedGraph;
  /** Orphan nodes appended to the graph (absent from it: no crawled page links to them). */
  readonly orphanNodesAdded: number;
  /** Click depth from the home page per node (−1 = unreachable). */
  readonly depth: Map<string, number>;
  readonly bodyWeight: number;
  readonly config: Readonly<LinkLensConfig>;
}

/**
 * Everything orphan rescue needs for a run under `policyId` (the run's stored config): the
 * reconciled orphans with their rescue fetch and page (if any), the site's text model, and the
 * weighted graph extended with the orphans. Nothing is written.
 */
export async function loadRescueInputs(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
  refVariant: RefVariant = "weighted",
): Promise<RescueInputs> {
  const [rec, { model, config }, prominence, { observations, context }, pages, fetches] =
    await Promise.all([
      loadReconciliation(db, runId, policyId),
      loadTextModel(db, runId, policyId),
      loadProminence(db, runId, policyId),
      loadRunGraphInputs(db, runId),
      listPages(db, runId, "rescue"),
      listFetches(db, runId),
    ]);
  const policy = POLICIES[policyId];
  const { graph, seedNode } = buildLinkGraph({
    seedUrl: observations.seedUrl,
    pages: observations.pages,
    links: observations.links,
    isInternal: makeInternalTest(observations.seedUrl, config.includeSubdomains),
    canonicalise: (url) => policy.canonicalise(url, context),
  });

  // The latest rescue fetch per requested URL, and the page extracted from it.
  const rescue = new Map<string, FetchRow>();
  for (const f of fetches) if (f.purpose === "rescue") rescue.set(f.requestedUrl, f);
  const pageOf = new Map(pages.map((p) => [p.fetchId, p]));

  const orphans: OrphanInput[] = rec.inventory
    .filter((e) => e.orphan)
    .map((e) => {
      const fetch = e.urls.map((u) => rescue.get(u)).find((f) => f !== undefined) ?? null;
      const page = fetch === null ? undefined : pageOf.get(fetch.id);
      const present = (xs: (string | null)[]) =>
        xs.filter((x): x is string => x !== null && x !== "");
      return {
        node: e.node,
        urls: e.urls,
        channels: e.channels,
        sources: e.sources,
        page:
          page === undefined
            ? null
            : { title: present([page.title, page.h1]), body: present([page.bodyText]) },
        fetch:
          fetch === null
            ? null
            : {
                requestedUrl: fetch.requestedUrl,
                statusCode: fetch.statusCode,
                contentType: fetch.contentType,
                error: fetch.error,
              },
      };
    });

  const known = new Set(graph.nodes());
  const extra = orphans
    .map((o) => o.node)
    .filter((n) => !known.has(n))
    .sort();
  const g = weightedGraph(
    [...graph.nodes(), ...extra],
    seedNode,
    prominence.edges.map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.structuralWeight,
    })),
  );
  const d = depthFromSeed(g);
  return {
    policyVersion: policy.version,
    refVariant,
    orphans,
    model,
    graph: g,
    orphanNodesAdded: extra.length,
    depth: new Map(g.nodes.map((n, i) => [n, d[i] as number])),
    bodyWeight: config.prominenceRegionWeights.body,
    config,
  };
}
