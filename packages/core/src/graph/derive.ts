import { makeConfig, type LinkLensConfig } from "../config.js";
import {
  buildCanonicalContext,
  observationsFromRows,
  POLICIES,
  type CanonicalContext,
  type PolicyId,
} from "../canonicalise/index.js";
import {
  getRun,
  getSite,
  insertArtefact,
  listFetches,
  listLinkObservations,
  listPages,
} from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import {
  buildLinkGraph,
  type LinkGraph,
  type LinkInput,
  type NodeMetrics,
  type PageInput,
} from "./build.js";
import { betweenness, bfsDepth, collapse, pagerank, scc } from "./metrics.js";
import { makeInternalTest } from "./scope.js";

export const LINK_GRAPH_ARTEFACT = "link-graph";

export interface GraphSummary {
  readonly runId: number;
  readonly policyVersion: string;
  readonly seedNode: string;
  readonly nodes: number;
  readonly edges: number;
  readonly weightedEdges: number;
  readonly selfLoops: number;
  readonly externalLinks: number;
  readonly duplicatePageLinks: number;
  readonly reachable: number;
  readonly sccCount: number;
  readonly largestSccSize: number;
  readonly pagerank: {
    readonly iterations: number;
    readonly converged: boolean;
    readonly damping: number;
  };
  readonly betweenness: {
    readonly sampled: boolean;
    readonly sources: number;
    readonly seed: number;
  };
}

export interface DerivedGraph {
  /** Multigraph with NodeAttributes & NodeMetrics on nodes and observation attributes on edges. */
  readonly graph: LinkGraph;
  readonly summary: GraphSummary;
}

export interface GraphObservations {
  readonly runId: number;
  readonly seedUrl: string;
  readonly pages: readonly PageInput[];
  readonly links: readonly LinkInput[];
}

/** Pure: build the policy's graph from observations and compute every metric on it. */
export function deriveGraphFromObservations(
  obs: GraphObservations,
  policyId: PolicyId,
  context: CanonicalContext,
  config: Readonly<LinkLensConfig>,
): DerivedGraph {
  const policy = POLICIES[policyId];
  const built = buildLinkGraph({
    seedUrl: obs.seedUrl,
    pages: obs.pages,
    links: obs.links,
    isInternal: makeInternalTest(obs.seedUrl, config.includeSubdomains),
    canonicalise: (url) => policy.canonicalise(url, context),
  });
  const { graph, seedNode } = built;
  const g = collapse(graph);
  const n = g.nodes.length;
  const pr = pagerank(
    g,
    config.pagerankDamping,
    config.pagerankTolerance,
    config.pagerankMaxIterations,
  );
  const depth = bfsDepth(g, g.index.get(seedNode) as number);
  const components = scc(g);
  const bc = betweenness(g, {
    exactMaxNodes: config.betweennessExactMaxNodes,
    samples: config.betweennessSamples,
    seed: config.randomSeed,
  });
  const inNeighbours = new Int32Array(n);
  for (const edges of g.out) for (const [j] of edges) inNeighbours[j] = (inNeighbours[j] ?? 0) + 1;
  const norm = n >= 3 ? (n - 1) * (n - 2) : 0;

  g.nodes.forEach((node, i) => {
    const d = depth[i] ?? -1;
    const b = bc.scores[i] ?? 0;
    const metrics: NodeMetrics = {
      pagerank: pr.scores[i] ?? 0,
      depth: d === -1 ? null : d,
      reachable: d !== -1,
      inDegree: graph.inDegree(node),
      outDegree: graph.outDegree(node),
      inNeighbours: inNeighbours[i] ?? 0,
      outNeighbours: (g.out[i] ?? []).length,
      sccId: components.component[i] ?? 0,
      inLargestScc: components.component[i] === components.largest,
      betweenness: b,
      betweennessNormalized: norm > 0 ? b / norm : 0,
    };
    graph.mergeNodeAttributes(node, metrics);
  });

  const summary: GraphSummary = {
    runId: obs.runId,
    policyVersion: policy.version,
    seedNode,
    nodes: n,
    edges: graph.size,
    weightedEdges: g.out.reduce((s, e) => s + e.length, 0),
    selfLoops: built.stats.selfLoops,
    externalLinks: built.stats.externalLinks,
    duplicatePageLinks: built.stats.duplicatePageLinks,
    reachable: depth.reduce((s, d) => s + (d === -1 ? 0 : 1), 0),
    sccCount: components.sizes.length,
    largestSccSize: components.sizes[components.largest] ?? 0,
    pagerank: {
      iterations: pr.iterations,
      converged: pr.converged,
      damping: config.pagerankDamping,
    },
    betweenness: { sampled: bc.sampled, sources: bc.sources, seed: config.randomSeed },
  };
  graph.replaceAttributes({ ...summary });
  return { graph, summary };
}

export interface PersistedGraph extends DerivedGraph {
  readonly artefact: ArtefactRow;
}

export interface RunGraphInputs {
  readonly observations: GraphObservations;
  readonly context: CanonicalContext;
  readonly config: Readonly<LinkLensConfig>;
}

/**
 * A run's crawl observations and the P4/P5 context built from them, using the run's stored
 * config. Only `crawl` fetches feed the context, so discovery (which runs later) cannot change
 * the graph derived from a crawl.
 */
export async function loadRunGraphInputs(db: Queryable, runId: number): Promise<RunGraphInputs> {
  const run = await getRun(db, runId);
  if (run === null) throw new Error(`run ${runId} not found`);
  const site = await getSite(db, run.siteId);
  if (site === null) throw new Error(`site ${run.siteId} not found`);
  const config = makeConfig(run.config);

  const [pages, links, fetches] = await Promise.all([
    listPages(db, runId, "crawl"),
    listLinkObservations(db, runId),
    listFetches(db, runId),
  ]);
  const context = buildCanonicalContext(
    observationsFromRows(
      fetches.filter((f) => f.purpose === "crawl"),
      pages,
    ),
    { maxCanonicalHops: config.canonicalMaxHops },
  );
  return {
    config,
    context,
    observations: {
      runId,
      seedUrl: site.rootUrl,
      pages: pages.map((p) => ({ fetchId: p.fetchId, url: p.url })),
      links: links.map((l) => ({
        id: l.id,
        sourceFetchId: l.sourceFetchId,
        resolvedUrl: l.resolvedUrl ?? "",
        domRegion: l.domRegion,
        anchorText: l.anchorText,
        templateSignature: l.templateSignature,
        rel: l.rel,
      })),
    },
  };
}

/**
 * Load a run's raw observations, derive the graph under `policyId` using the run's own stored
 * config (so re-deriving is reproducible), and persist it as a `link-graph` artefact tagged with
 * the run id and the policy version. The payload is graphology's serialisation of the graph.
 */
export async function deriveGraph(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<PersistedGraph> {
  const { observations, context, config } = await loadRunGraphInputs(db, runId);
  const derived = deriveGraphFromObservations(observations, policyId, context, config);
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion: derived.summary.policyVersion,
    kind: LINK_GRAPH_ARTEFACT,
    payload: derived.graph.export() as unknown as Json,
  });
  return { ...derived, artefact };
}
