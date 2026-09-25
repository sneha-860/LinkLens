import {
  canonicalise,
  db as q,
  diagnosis,
  fixes,
  graph,
  makeConfig,
  prominence,
  semantic,
  stats,
  text,
  type LinkLensConfig,
  type SigmaVariant,
} from "@linklens/core";

type PolicyId = canonicalise.PolicyId;

/** What the hide-and-recover pipeline reads from a run (nothing is written). */
export interface RecoveryInputs {
  readonly runId: number;
  readonly policyId: PolicyId;
  readonly config: Readonly<LinkLensConfig>;
  readonly observations: graph.GraphObservations;
  readonly context: canonicalise.CanonicalContext;
  /** Crawl pages (title, h1, body text). */
  readonly pages: readonly Pick<q.PageRow, "fetchId" | "url" | "title" | "h1" | "bodyText">[];
  /** Every link observation of the run (anchors, regions, positions). */
  readonly linkRows: readonly q.LinkObservationRow[];
  /** The run's cosine matrix under the policy (null: cosine counts as 0). */
  readonly cosine: semantic.CosineMatrix | null;
}

export async function loadRecoveryInputs(
  db: q.Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<RecoveryInputs> {
  const { observations, context, config } = await graph.loadRunGraphInputs(db, runId);
  const [pages, linkRows, cosines] = await Promise.all([
    q.listPages(db, runId, "crawl"),
    q.listLinkObservations(db, runId),
    q.listArtefacts(db, runId, {
      kind: semantic.COSINE_ARTEFACT,
      policyVersion: canonicalise.POLICIES[policyId].version,
    }),
  ]);
  return {
    runId,
    policyId,
    config,
    observations,
    context,
    pages,
    linkRows,
    cosine: (cosines.at(-1)?.payload ?? null) as unknown as semantic.CosineMatrix | null,
  };
}

export interface RecoveryOptions {
  /** Existing main-content links to hide (fewer if the site has fewer). */
  readonly sample: number;
  readonly seed: number;
  readonly sigmas: readonly SigmaVariant[];
  readonly ks: readonly number[];
  /** Candidates must have REF > ε (false for the σ ablation). */
  readonly requireRef: boolean;
}

export interface RecoveryResult {
  readonly runId: number;
  readonly policyVersion: string;
  readonly options: RecoveryOptions;
  /** The hidden (donor, target) pairs. */
  readonly hidden: { readonly donor: string; readonly target: string }[];
  /** Hidden donors that came back as candidates for their target (before ranking). */
  readonly candidateRecall: number | null;
  readonly candidates: number;
  /** Per σ: the rank of each hidden donor among its target's fixes, MRR and recall@k. */
  readonly bySigma: Record<
    string,
    {
      readonly ranks: (number | null)[];
      readonly mrr: number | null;
      readonly recall: Record<number, number | null>;
    }
  >;
  /** Top-k (k = the largest) Jaccard between the σ variants' rankings of all candidates. */
  readonly sigmaAgreement: { readonly a: string; readonly b: string; readonly jaccard: number }[];
}

const pairKey = (s: string, t: string) => JSON.stringify([s, t]);

/**
 * E6 hide-and-recover (and E7 per σ): hide a seeded sample of existing main-content links (every
 * observation of each pair, so the donor also loses the anchor), rebuild the text model, REF,
 * prominence, diagnosis, candidates, counterfactual and scores in memory, and record the rank at
 * which each hidden donor comes back for its target.
 */
export function hideAndRecover(input: RecoveryInputs, options: RecoveryOptions): RecoveryResult {
  const { config, context, observations } = input;
  const policy = canonicalise.POLICIES[input.policyId];
  const canon = (url: string) => policy.canonicalise(url, context);
  const isInternal = graph.makeInternalTest(observations.seedUrl, config.includeSubdomains);
  const build = (links: readonly graph.LinkInput[]) =>
    graph.buildLinkGraph({
      seedUrl: observations.seedUrl,
      pages: observations.pages,
      links,
      isInternal,
      canonicalise: canon,
    });

  // 1. Candidate links to hide: main-content edges between two crawled pages.
  const full = build(observations.links).graph;
  const eligible = new Map<string, { donor: string; target: string }>();
  full.forEachEdge((_e, a, s, t) => {
    if (s === t || prominence.regionClass(a.domRegion) !== "body") return;
    if (!full.getNodeAttribute(s, "crawled") || !full.getNodeAttribute(t, "crawled")) return;
    eligible.set(pairKey(s, t), { donor: s, target: t });
  });
  const pool = [...eligible.keys()].sort();
  const chosen = graph.sampleWithoutReplacement(
    pool,
    options.sample,
    graph.mulberry32(options.seed),
  );
  const hiddenPairs = new Set(chosen);
  const hiddenObs = new Set<number>();
  full.forEachEdge((_e, a, s, t) => {
    if (hiddenPairs.has(pairKey(s, t))) hiddenObs.add(a.observationId);
  });

  // 2. The site without those links.
  const links = observations.links.filter((l) => !hiddenObs.has(l.id));
  const rows = input.linkRows.filter((l) => !hiddenObs.has(l.id));
  const g = build(links).graph;
  const seedNode = canon(observations.seedUrl);
  const pageByFetch = new Map(input.pages.map((p) => [p.fetchId, p]));
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

  // 3. The pipeline, in memory.
  const cfg = makeConfig({ ...config, candidateRequireRef: options.requireRef });
  const model = text.buildTextModel(
    { runId: input.runId, policyVersion: policy.version, documents },
    cfg,
  );
  const ref = semantic.refMatrix(model, "weighted", cfg);
  const prom = {
    ...prominence.computeProminence({ pages: pageLinks }, cfg),
    runId: input.runId,
    policyVersion: policy.version,
  };
  const { diagnoses } = diagnosis.diagnose({ ref, prominence: prom }, cfg);
  const targets = new Map(
    [...new Set(chosen.map((k) => eligible.get(k)?.target as string))].map((t) => [
      t,
      new Set<fixes.TargetReason>(["v4"]),
    ]),
  );
  const list = fixes.generateCandidates({ targets, ref, edges: prom.edges, diagnoses }, cfg);

  const wg = fixes.weightedGraph(
    g.nodes(),
    seedNode,
    prom.edges.map((e) => ({ source: e.source, target: e.target, weight: e.structuralWeight })),
  );
  const base = fixes.baseline(wg, cfg);
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
      cfg.prominenceRegionWeights.body,
      cfg,
      true,
      ws,
    ),
  );
  const effort = fixes.effortByNode(pageLinks);
  const cosine = (u: string, v: string) =>
    input.cosine === null ? null : semantic.cosineOf(input.cosine, u, v);

  // 4. Where did each hidden donor land, per σ?
  const hidden = chosen.map((k) => eligible.get(k) as { donor: string; target: string });
  const bySigma: RecoveryResult["bySigma"] = {};
  const topSets = new Map<string, Set<string>>();
  const kMax = Math.max(...options.ks);
  for (const sigma of options.sigmas) {
    const ranked = fixes.scoreFixes(
      { policyVersion: policy.version, candidates: list.candidates, results, cosine, effort },
      { ...cfg, sigmaVariant: sigma },
    );
    const rankOf = new Map(ranked.map((f) => [pairKey(f.donor, f.target), f.targetRank]));
    const ranks = hidden.map((h) => rankOf.get(pairKey(h.donor, h.target)) ?? null);
    const m = stats.rankingMetrics(ranks, options.ks);
    bySigma[sigma] = { ranks, mrr: m.mrr, recall: m.recall };
    topSets.set(sigma, new Set(fixes.topK(ranked, kMax).map((f) => pairKey(f.donor, f.target))));
  }
  const sigmaAgreement: RecoveryResult["sigmaAgreement"] = [];
  const names = [...topSets.keys()];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      sigmaAgreement.push({
        a: names[i] as string,
        b: names[j] as string,
        jaccard: stats.jaccard(
          topSets.get(names[i] as string) as Set<string>,
          topSets.get(names[j] as string) as Set<string>,
        ),
      });
    }
  }
  const candidatePairs = new Set(list.candidates.map((c) => pairKey(c.donor, c.target)));
  return {
    runId: input.runId,
    policyVersion: policy.version,
    options,
    hidden,
    candidateRecall:
      hidden.length === 0
        ? null
        : hidden.filter((h) => candidatePairs.has(pairKey(h.donor, h.target))).length /
          hidden.length,
    candidates: list.candidates.length,
    bySigma,
    sigmaAgreement,
  };
}
