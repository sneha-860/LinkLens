import {
  audit as auditCore,
  canonicalise,
  db as q,
  diagnosis,
  discovery,
  fixes,
  graph,
  importance as importanceCore,
  makeConfig,
  prominence,
  semantic,
  text,
  type FixScoring,
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
  /** schema.org types of each crawl page's stored HTML, for page importance (L12). */
  readonly schemaTypes?: ReadonlyMap<number, string[]>;
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
  const schemaTypes = await importanceCore.loadSchemaTypes(
    db,
    runId,
    pages.map((p) => p.fetchId),
  );
  return {
    runId,
    startedAt: run.startedAt,
    config,
    observations,
    context,
    schemaTypes,
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

/** The settings E7 varies; everything else comes from the run's stored config. */
export interface RankingSettings {
  readonly epsilon: number;
  readonly alpha: number;
  readonly sigma: SigmaVariant;
  /** "S" (default) or "S_imp" = S × importance(target) (L12). */
  readonly scoring?: FixScoring;
}

/**
 * A run's pipeline prepared up to what does not depend on ε, α or σ (graph, reconciliation,
 * structural audit, text model, prominence, κ), with `rank(settings)` for the rest: REF (ε),
 * diagnosis (α), candidates (ε, α), counterfactual (cached per ε and α, as it depends only on
 * the candidates) and scoring (σ, and ε through the REF gate).
 */
export interface PreparedRun {
  readonly crawled: Set<string>;
  readonly pagerank: Map<string, number>;
  readonly orphans: Set<string>;
  /** P3 form of a node, to compare fixes between runs or scopes. */
  readonly p3: (node: string) => string;
  rank(settings: RankingSettings): fixes.FixRecord[];
  /** Page type and importance of every node (L12), computed once on first use. */
  importance(): importanceCore.PageImportance;
  /** What the ranking is computed from, for feature extraction (L13). */
  readonly state: PreparedState;
}

/** The prepared pipeline's intermediate state (read-only use). */
export interface PreparedState {
  readonly policyVersion: string;
  readonly config: Readonly<LinkLensConfig>;
  readonly graph: graph.LinkGraph;
  readonly seedNode: string;
  readonly model: text.TextModel;
  readonly prominence: prominence.RunProminence;
  readonly effort: Map<string, fixes.DonorEffort>;
  /** The structural-prominence weighted graph, its baseline PageRank and node index. */
  readonly weighted: fixes.WeightedGraph;
  readonly base: fixes.Baseline;
  readonly index: Map<string, number>;
  readonly workspace: ReturnType<typeof fixes.workspace>;
  readonly cosine: (u: string, v: string) => number | null;
}

export function prepareRun(
  inputs: RunInputs,
  options: Pick<InMemoryOptions, "policyId" | "pages" | "discovery">,
): PreparedRun {
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

  // Text, prominence and κ, from the representative pages.
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
  const prom = {
    ...prominence.computeProminence({ pages: pageLinks }, config),
    runId: inputs.runId,
    policyVersion: policy.version,
  };
  const effort = fixes.effortByNode(pageLinks);
  const wg = fixes.weightedGraph(
    g.nodes(),
    derived.summary.seedNode,
    prom.edges.map((e) => ({ source: e.source, target: e.target, weight: e.structuralWeight })),
  );
  const base = fixes.baseline(wg, config);
  const index = new Map(wg.nodes.map((n, i) => [n, i]));
  const ws = fixes.workspace(wg);
  const cosine = (u: string, v: string) =>
    inputs.cosine === null ? null : semantic.cosineOf(inputs.cosine, u, v);

  // Candidates and their counterfactual, per (ε, α).
  const simulated = new Map<
    string,
    { candidates: fixes.Candidate[]; results: fixes.CounterfactualResult[] }
  >();
  const candidatesFor = (epsilon: number, alpha: number) => {
    const key = `${epsilon}|${alpha}`;
    let hit = simulated.get(key);
    if (hit === undefined) {
      const cfg = makeConfig({ ...config, epsilon, alpha });
      const ref = semantic.refMatrix(model, "weighted", cfg);
      const { diagnoses } = diagnosis.diagnose({ ref, prominence: prom }, cfg);
      const list = fixes.generateCandidates(
        {
          targets: fixes.candidateTargets(audit.issues, diagnoses),
          ref,
          edges: prom.edges,
          diagnoses,
        },
        cfg,
      );
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
      hit = { candidates: list.candidates, results };
      simulated.set(key, hit);
    }
    return hit;
  };

  let importance: importanceCore.PageImportance | null = null;
  const importanceOf = () =>
    (importance ??= importanceCore.computeImportance(
      {
        runId: inputs.runId,
        policyVersion: policy.version,
        graph: g,
        seedNode: derived.summary.seedNode,
        bodyText: (id) => pageByFetch.get(id)?.bodyText ?? null,
        schemaTypes: (id) => inputs.schemaTypes?.get(id) ?? [],
      },
      config,
    ));

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
    p3,
    importance: importanceOf,
    state: {
      policyVersion: policy.version,
      config,
      graph: g,
      seedNode: derived.summary.seedNode,
      model,
      prominence: prom,
      effort,
      weighted: wg,
      base,
      index,
      workspace: ws,
      cosine,
    },
    rank: ({ epsilon, alpha, sigma, scoring = "S" }) => {
      const { candidates, results } = candidatesFor(epsilon, alpha);
      const nodes = scoring === "S_imp" ? importanceOf().nodes : null;
      return fixes.scoreFixes(
        {
          policyVersion: policy.version,
          candidates,
          results,
          cosine,
          effort,
          ...(nodes === null ? {} : { importance: (n: string) => nodes[n]?.importance ?? null }),
        },
        { ...makeConfig({ ...config, epsilon, alpha }), sigmaVariant: sigma, fixScoring: scoring },
      );
    },
  };
}

/** The top-k fixes as "donor -> target" in P3 form. */
export const topFixKeys = (
  run: Pick<PreparedRun, "p3">,
  ranked: readonly fixes.FixRecord[],
  k: number,
) => new Set(fixes.topK(ranked, k).map((f) => `${run.p3(f.donor)} -> ${run.p3(f.target)}`));

/**
 * Pure: the audit of a run as the pipeline derives it (graph, reconciliation, structural
 * audit, text, REF, prominence, diagnosis, candidates, counterfactual, κ, scoring), in memory,
 * optionally restricted to some crawled pages and discovery observations. Unrestricted, it
 * reproduces the stored ranking (checked by the E4 integration test).
 */
export function auditInMemory(inputs: RunInputs, options: InMemoryOptions): AuditOutcome {
  const run = prepareRun(inputs, options);
  const ranked = run.rank({
    epsilon: inputs.config.epsilon,
    alpha: inputs.config.alpha,
    sigma: options.sigma ?? inputs.config.sigmaVariant,
  });
  return {
    crawled: run.crawled,
    pagerank: run.pagerank,
    orphans: run.orphans,
    topFixes: topFixKeys(run, ranked, options.k),
    fixes: ranked.length,
  };
}
