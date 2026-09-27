import {
  audit as auditCore,
  canonicalise,
  db as q,
  diagnosis,
  discovery,
  fixes,
  graph,
  prominence,
  semantic,
  text,
  type LinkLensConfig,
  type SigmaVariant,
} from "@linklens/core";

type PolicyId = canonicalise.PolicyId;

/** Everything a run's audit is derived from (the raw observations; nothing derived). */
export interface RunInputs {
  readonly runId: number;
  readonly startedAt: Date;
  readonly config: Readonly<LinkLensConfig>;
  readonly observations: graph.GraphObservations;
  readonly context: canonicalise.CanonicalContext;
  /** Crawl pages (2xx HTML). */
  readonly pages: readonly q.PageRow[];
  readonly linkRows: readonly q.LinkObservationRow[];
  /** Every crawl fetch (all attempts). */
  readonly fetches: readonly q.FetchRow[];
  readonly discovery: readonly q.DiscoveryObservationRow[];
  /** The run's latest cosine matrix under the policy (null: cosine counts as 0). */
  readonly cosine: semantic.CosineMatrix | null;
}

export async function loadRunInputs(
  db: q.Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<RunInputs> {
  const run = await q.getRun(db, runId);
  if (run === null) throw new Error(`run ${runId} not found`);
  const { observations, context, config } = await graph.loadRunGraphInputs(db, runId);
  const [pages, linkRows, fetches, disc, cosines] = await Promise.all([
    q.listPages(db, runId, "crawl"),
    q.listLinkObservations(db, runId),
    q.listFetches(db, runId),
    q.listDiscoveryObservations(db, runId),
    q.listArtefacts(db, runId, {
      kind: semantic.COSINE_ARTEFACT,
      policyVersion: canonicalise.POLICIES[policyId].version,
    }),
  ]);
  return {
    runId,
    startedAt: run.startedAt,
    config,
    observations,
    context,
    pages,
    linkRows,
    fetches: fetches.filter((f) => f.purpose === "crawl"),
    discovery: disc,
    cosine: (cosines.at(-1)?.payload ?? null) as unknown as semantic.CosineMatrix | null,
  };
}

/** What the audit concludes, keyed in P3 form so two runs (or two scopes) can be compared. */
export interface AuditOutcome {
  /** Crawled pages. */
  readonly crawled: Set<string>;
  /** PageRank per P3 page (merged nodes summed). */
  readonly pagerank: Map<string, number>;
  readonly orphans: Set<string>;
  /** The top-k fixes as "donor -> target". */
  readonly topFixes: Set<string>;
  readonly fixes: number;
}

export interface InMemoryOptions {
  readonly policyId: PolicyId;
  readonly k: number;
  readonly sigma?: SigmaVariant;
  /** Only these crawled pages (P3 form) count as crawled (default: all). */
  readonly pages?: ReadonlySet<string>;
  /** Only discovery observations this keeps (default: all). */
  readonly discovery?: (o: q.DiscoveryObservationRow) => boolean;
}

/** P3 form of a URL under the run's context (the form where two runs' pages meet). */
export const p3Of = (inputs: Pick<RunInputs, "context">) => (url: string) =>
  canonicalise.POLICIES.P3.canonicalise(url, inputs.context);

/**
 * Pure: the audit of a run as the pipeline derives it (graph, reconciliation, structural
 * audit, text, REF, prominence, diagnosis, candidates, counterfactual, κ, scoring), in memory,
 * optionally restricted to some crawled pages and discovery observations. Unrestricted, it
 * reproduces the stored ranking (checked by the E4 integration test).
 */
export function auditInMemory(inputs: RunInputs, options: InMemoryOptions): AuditOutcome {
  const { config, context } = inputs;
  const policy = canonicalise.POLICIES[options.policyId];
  const canon = (url: string) => policy.canonicalise(url, context);
  const p3 = p3Of(inputs);
  const keep = options.pages;
  const pages = inputs.pages.filter((p) => keep === undefined || keep.has(p3(p.url)));
  const fetchIds = new Set(pages.map((p) => p.fetchId));
  const obs: graph.GraphObservations = {
    ...inputs.observations,
    pages: inputs.observations.pages.filter((p) => fetchIds.has(p.fetchId)),
    links: inputs.observations.links.filter((l) => fetchIds.has(l.sourceFetchId)),
  };
  const rows = inputs.linkRows.filter((l) => fetchIds.has(l.sourceFetchId));

  // Graph, reconciliation, audit.
  const derived = graph.deriveGraphFromObservations(obs, options.policyId, context, config);
  const g = derived.graph;
  const reach = new Map<string, { reachable: boolean; depth: number | null }>();
  g.forEachNode((n, a) =>
    reach.set(n, { reachable: a.reachable === true, depth: a.depth ?? null }),
  );
  const disc = inputs.discovery.filter(options.discovery ?? (() => true));
  const isInternal = graph.makeInternalTest(obs.seedUrl, config.includeSubdomains);
  const reconciliation =
    disc.length === 0
      ? null
      : discovery.reconcile({
          runId: inputs.runId,
          policyVersion: policy.version,
          observations: disc,
          isInternal,
          canonicalise: canon,
          graph: reach,
        });
  const xRobots = new Map(inputs.fetches.map((f) => [f.id, f.headers["x-robots-tag"] ?? null]));
  const audit = auditCore.auditStructure({
    runId: inputs.runId,
    policyVersion: policy.version,
    graph: g,
    reconciliation,
    pages: pages.map((p) => ({
      fetchId: p.fetchId,
      url: p.url,
      metaRobots: p.metaRobots,
      metaCanonical: p.metaCanonical,
      xRobotsTag: xRobots.get(p.fetchId) ?? null,
    })),
    canonicalise: canon,
    config,
  });

  // Text, REF, prominence, diagnosis and candidates, from the representative pages.
  const pageByFetch = new Map(pages.map((p) => [p.fetchId, p]));
  const rowsByFetch = new Map<number, q.LinkObservationRow[]>();
  for (const r of rows)
    rowsByFetch.set(r.sourceFetchId, [...(rowsByFetch.get(r.sourceFetchId) ?? []), r]);
  const documents: text.RawDocument[] = [];
  const pageLinks: prominence.PageLinks[] = [];
  g.forEachNode((node, a) => {
    const page =
      a.representativeFetchId === null ? undefined : pageByFetch.get(a.representativeFetchId);
    if (page === undefined) return;
    const pageRows = rowsByFetch.get(page.fetchId) ?? [];
    documents.push(text.rawDocument(node, page, pageRows));
    pageLinks.push({
      node,
      links: pageRows.map((r) => ({
        observationId: r.id,
        domRegion: r.domRegion,
        templateSignature: r.templateSignature,
        positionIndex: r.positionIndex,
        target: g.hasEdge(`obs:${r.id}`) ? g.target(`obs:${r.id}`) : null,
      })),
    });
  });
  const model = text.buildTextModel(
    { runId: inputs.runId, policyVersion: policy.version, documents },
    config,
  );
  const ref = semantic.refMatrix(model, "weighted", config);
  const prom = {
    ...prominence.computeProminence({ pages: pageLinks }, config),
    runId: inputs.runId,
    policyVersion: policy.version,
  };
  const { diagnoses } = diagnosis.diagnose({ ref, prominence: prom }, config);
  const list = fixes.generateCandidates(
    { targets: fixes.candidateTargets(audit.issues, diagnoses), ref, edges: prom.edges, diagnoses },
    config,
  );

  // Counterfactual and scoring.
  const wg = fixes.weightedGraph(
    g.nodes(),
    derived.summary.seedNode,
    prom.edges.map((e) => ({ source: e.source, target: e.target, weight: e.structuralWeight })),
  );
  const base = fixes.baseline(wg, config);
  const index = new Map(wg.nodes.map((n, i) => [n, i]));
  const ws = fixes.workspace(wg);
  const results = list.candidates.map((c) =>
    fixes.simulate(
      wg,
      base,
      {
        id: c.id,
        donor: index.get(c.donor) as number,
        target: index.get(c.target) as number,
        action: c.action,
      },
      config.prominenceRegionWeights.body,
      config,
      true,
      ws,
    ),
  );
  const cosine = (u: string, v: string) =>
    inputs.cosine === null ? null : semantic.cosineOf(inputs.cosine, u, v);
  const ranked = fixes.scoreFixes(
    {
      policyVersion: policy.version,
      candidates: list.candidates,
      results,
      cosine,
      effort: fixes.effortByNode(pageLinks),
    },
    { ...config, sigmaVariant: options.sigma ?? config.sigmaVariant },
  );

  const crawled = new Set<string>();
  const pagerank = new Map<string, number>();
  g.forEachNode((n, a) => {
    const key = p3(n);
    if (a.crawled) crawled.add(key);
    pagerank.set(key, (pagerank.get(key) ?? 0) + (a.pagerank ?? 0));
  });
  return {
    crawled,
    pagerank,
    orphans: new Set((reconciliation?.orphans ?? []).map(p3)),
    topFixes: new Set(
      fixes.topK(ranked, options.k).map((f) => `${p3(f.donor)} -> ${p3(f.target)}`),
    ),
    fixes: ranked.length,
  };
}
