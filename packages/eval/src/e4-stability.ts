import { canonicalise, db as q, diagnosis, discovery, fixes, graph, stats } from "@linklens/core";

type PolicyId = canonicalise.PolicyId;

export interface RunSnapshot {
  readonly runId: number;
  readonly startedAt: Date;
  /** Everything keyed in P3 form (comparable between runs). */
  readonly pages: Set<string>;
  readonly edges: Set<string>;
  readonly pagerank: Map<string, number>;
  readonly depth: Map<string, number>;
  readonly orphans: Set<string>;
  readonly topFixes: Set<string> | null;
  readonly cases: Map<string, string>;
}

export interface Stability {
  readonly runA: number;
  readonly runB: number;
  readonly daysApart: number;
  readonly pagesJaccard: number;
  readonly edgesJaccard: number;
  readonly orphansJaccard: number;
  readonly pagerankSpearman: number | null;
  readonly meanAbsDepthShift: number | null;
  readonly topFixesJaccard: number | null;
  /** Share of pairs diagnosed in both runs that got the same case. */
  readonly caseAgreement: number | null;
  readonly casePairs: number;
}

/** A run's comparable facts under a policy, keyed in P3 form. */
export async function snapshot(
  db: q.Queryable,
  runId: number,
  policyId: PolicyId,
  k: number,
): Promise<RunSnapshot> {
  const run = await q.getRun(db, runId);
  if (run === null) throw new Error(`run ${runId} not found`);
  const { observations, context, config } = await graph.loadRunGraphInputs(db, runId);
  const p3 = (u: string) => canonicalise.POLICIES.P3.canonicalise(u, context);
  const version = canonicalise.POLICIES[policyId].version;
  const derived = graph.deriveGraphFromObservations(observations, policyId, context, config);
  const pages = new Set<string>();
  const pagerank = new Map<string, number>();
  const depth = new Map<string, number>();
  derived.graph.forEachNode((n, a) => {
    const key = p3(n);
    if (a.crawled) pages.add(key);
    pagerank.set(key, (pagerank.get(key) ?? 0) + (a.pagerank ?? 0));
    if (a.depth !== null && a.depth !== undefined)
      depth.set(key, Math.min(depth.get(key) ?? Infinity, a.depth));
  });
  const edges = new Set<string>();
  derived.graph.forEachEdge((_e, _a, s, t) => {
    edges.add(`${p3(s)} -> ${p3(t)}`);
  });
  const [rec, rankings, diags] = await Promise.all([
    discovery.loadReconciliation(db, runId, policyId),
    q.listArtefacts(db, runId, { kind: fixes.FIX_RANKING_ARTEFACT, policyVersion: version }),
    q.listArtefacts(db, runId, { kind: diagnosis.DIAGNOSIS_ARTEFACT, policyVersion: version }),
  ]);
  const ranking = rankings.at(-1)?.payload as unknown as fixes.FixRanking | undefined;
  const diag = diags.at(-1)?.payload as unknown as diagnosis.DiagnosisReport | undefined;
  return {
    runId,
    startedAt: run.startedAt,
    pages,
    edges,
    pagerank,
    depth,
    orphans: new Set(rec.orphans.map(p3)),
    topFixes:
      ranking === undefined
        ? null
        : new Set(ranking.fixes.slice(0, k).map((f) => `${p3(f.donor)} -> ${p3(f.target)}`)),
    cases: new Map(
      (diag?.diagnoses ?? []).map((d) => [`${p3(d.source)} -> ${p3(d.target)}`, d.case]),
    ),
  };
}

/** E4: how stable the audit is between two crawls of the same site (e.g. 14 days apart). */
export function compareSnapshots(a: RunSnapshot, b: RunSnapshot): Stability {
  const shift = stats.depthShift(b.depth, a.depth);
  const common = [...a.cases.keys()].filter((k) => b.cases.has(k));
  return {
    runA: a.runId,
    runB: b.runId,
    daysApart: Math.abs(b.startedAt.getTime() - a.startedAt.getTime()) / 86_400_000,
    pagesJaccard: stats.jaccard(a.pages, b.pages),
    edgesJaccard: stats.jaccard(a.edges, b.edges),
    orphansJaccard: stats.jaccard(a.orphans, b.orphans),
    pagerankSpearman: stats.spearman(a.pagerank, b.pagerank),
    meanAbsDepthShift: shift?.meanAbs ?? null,
    topFixesJaccard:
      a.topFixes === null || b.topFixes === null ? null : stats.jaccard(a.topFixes, b.topFixes),
    caseAgreement:
      common.length === 0
        ? null
        : common.filter((k) => a.cases.get(k) === b.cases.get(k)).length / common.length,
    casePairs: common.length,
  };
}
