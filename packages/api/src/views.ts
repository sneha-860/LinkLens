import { zipSync, strToU8 } from "fflate";
import {
  audit as auditCore,
  canonicalise,
  db as q,
  diagnosis,
  discovery,
  fixes,
  graph,
  type SigmaVariant,
} from "@linklens/core";
import { toCsv } from "./csv.js";
import { notFound, notReady } from "./errors.js";
import { STAGES } from "./pipeline.js";

type PolicyId = canonicalise.PolicyId;
const versionOf = (p: PolicyId) => canonicalise.POLICIES[p].version;

export async function requireAudit(db: q.Queryable, id: number): Promise<q.AuditRow> {
  const a = await q.getAudit(db, id);
  if (a === null) throw notFound(`audit ${id}`);
  return a;
}

/** The latest artefact of a kind for the run under a policy, or null. */
export async function latest<P>(
  db: q.Queryable,
  runId: number,
  kind: string,
  policy: PolicyId,
  where: (p: P) => boolean = () => true,
): Promise<{ id: number; payload: P } | null> {
  const rows = await q.listArtefacts(db, runId, { kind, policyVersion: versionOf(policy) });
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as q.ArtefactRow;
    const payload = row.payload as unknown as P;
    if (where(payload)) return { id: row.id, payload };
  }
  return null;
}

// ---------- status ----------

export async function auditView(db: q.Queryable, a: q.AuditRow, active: boolean) {
  const [stages, run, finals] = await Promise.all([
    q.listAuditStages(db, a.runId),
    q.getRun(db, a.runId),
    q.listFinalFetches(db, a.runId),
  ]);
  const completed = stages.filter((s) => s.status === "completed").length;
  return {
    id: a.runId,
    url: a.rootUrl,
    policy: a.policy,
    options: a.options,
    status: a.status,
    active,
    currentStage: a.currentStage,
    error: a.error,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    crawl: {
      status: run?.status ?? null,
      pageCap: run?.config.pageCap ?? null,
      urlsFetched: finals.filter((f) => f.purpose === "crawl").length,
    },
    progress: {
      completedStages: completed,
      totalStages: STAGES.length,
      fraction: completed / STAGES.length,
    },
    stages: stages.map((s) => ({
      stage: s.stage,
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      durationMs: s.durationMs,
      detail: s.detail,
      error: s.error,
    })),
  };
}

// ---------- artefact views ----------

export async function graphView(db: q.Queryable, a: q.AuditRow, policy: PolicyId) {
  let row = await latest<q.Json>(db, a.runId, graph.LINK_GRAPH_ARTEFACT, policy);
  if (row === null) {
    const run = await q.getRun(db, a.runId);
    if (run?.status !== "completed") throw notReady("the link graph");
    const g = await graph.deriveGraph(db, a.runId, policy);
    row = { id: g.artefact.id, payload: g.artefact.payload };
  }
  return { policy, policyVersion: versionOf(policy), artefactId: row.id, graph: row.payload };
}

export async function issuesView(
  db: q.Queryable,
  a: q.AuditRow,
  policy: PolicyId,
  filter: { type?: string | undefined; severity?: string | undefined },
) {
  let row = await latest<auditCore.StructuralAudit>(
    db,
    a.runId,
    auditCore.STRUCTURAL_AUDIT_ARTEFACT,
    policy,
  );
  if (row === null) {
    if (policy === a.policy) throw notReady("the structural audit");
    const run = await q.getRun(db, a.runId);
    if (run?.status !== "completed") throw notReady("the structural audit");
    const r = await auditCore.auditRun(db, a.runId, policy);
    row = { id: r.artefact.id, payload: r };
  }
  const issues = row.payload.issues.filter(
    (i) =>
      (filter.type === undefined || i.type === filter.type) &&
      (filter.severity === undefined || i.severity === filter.severity),
  );
  return {
    policy,
    policyVersion: versionOf(policy),
    artefactId: row.id,
    summary: row.payload.summary,
    issues,
  };
}

export async function diagnosisView(db: q.Queryable, a: q.AuditRow, only?: string) {
  const policy = a.policy as PolicyId;
  const row = await latest<diagnosis.DiagnosisReport>(
    db,
    a.runId,
    diagnosis.DIAGNOSIS_ARTEFACT,
    policy,
  );
  if (row === null) throw notReady("the diagnosis");
  const expl = await latest<fixes.ExplanationSet>(db, a.runId, fixes.EXPLANATIONS_ARTEFACT, policy);
  const sentence = new Map((expl?.payload.diagnoses ?? []).map((d) => [d.id, d.sentence]));
  return {
    policy,
    artefactId: row.id,
    alpha: row.payload.alpha,
    epsilon: row.payload.epsilon,
    counts: row.payload.counts,
    diagnoses: row.payload.diagnoses
      .filter((d) => only === undefined || d.case === only)
      .map((d) => ({ ...d, explanation: sentence.get(d.id) ?? null })),
  };
}

/** The ranking for a σ variant: stored, or computed from the stored counterfactual. */
export async function rankingFor(db: q.Queryable, a: q.AuditRow, sigma: SigmaVariant) {
  const policy = a.policy as PolicyId;
  const stored = await latest<fixes.FixRanking>(
    db,
    a.runId,
    fixes.FIX_RANKING_ARTEFACT,
    policy,
    (p) => p.sigmaVariant === sigma,
  );
  if (stored !== null) return stored;
  const stages = await q.listAuditStages(db, a.runId);
  if (stages.find((s) => s.stage === "counterfactual")?.status !== "completed") {
    throw notReady("fix scoring");
  }
  const r = await fixes.buildFixRanking(db, a.runId, policy, { sigmaVariant: sigma });
  return { id: r.artefact.id, payload: r as fixes.FixRanking };
}

export async function fixesView(
  db: q.Queryable,
  a: q.AuditRow,
  sigma: SigmaVariant,
  k: number,
  scope: "global" | "target",
) {
  const ranking = await rankingFor(db, a, sigma);
  const expl = await latest<fixes.ExplanationSet>(
    db,
    a.runId,
    fixes.EXPLANATIONS_ARTEFACT,
    a.policy as PolicyId,
  );
  const byId = new Map((expl?.payload.fixes ?? []).map((e) => [e.id, e]));
  const withExplanation = (f: fixes.FixRecord) => {
    const e = byId.get(f.id);
    return { ...f, explanation: e === undefined ? null : { sentence: e.sentence, lines: e.lines } };
  };
  const all = ranking.payload.fixes;
  return {
    sigma,
    k,
    scope,
    artefactId: ranking.id,
    total: all.length,
    ...(scope === "global"
      ? { fixes: fixes.topK(all, k).map(withExplanation) }
      : {
          targets: [...fixes.topKPerTarget(all, k)].map(([target, list]) => ({
            target,
            fixes: list.map(withExplanation),
          })),
        }),
  };
}

export async function orphansView(db: q.Queryable, a: q.AuditRow) {
  const policy = a.policy as PolicyId;
  const row = await latest<{ counts: unknown; orphans: fixes.RescuedOrphan[] }>(
    db,
    a.runId,
    fixes.RESCUE_ARTEFACT,
    policy,
  );
  if (row === null) throw notReady("orphan rescue");
  const expl = await latest<fixes.ExplanationSet>(db, a.runId, fixes.EXPLANATIONS_ARTEFACT, policy);
  const byId = new Map((expl?.payload.rescues ?? []).map((e) => [e.id, e]));
  return {
    policy,
    artefactId: row.id,
    counts: row.payload.counts,
    orphans: row.payload.orphans.map((o) => ({
      ...o,
      donors: o.donors.map((d) => {
        const e = byId.get(`rescue:${d.donor}->${o.node}`);
        return {
          ...d,
          explanation: e === undefined ? null : { sentence: e.sentence, lines: e.lines },
        };
      }),
    })),
  };
}

export async function summaryView(db: q.Queryable, a: q.AuditRow, active: boolean) {
  const policy = a.policy as PolicyId;
  const [status, g, rec, issues, diag, ranking, rescue, pages] = await Promise.all([
    auditView(db, a, active),
    latest<{ attributes?: Record<string, unknown> }>(
      db,
      a.runId,
      graph.LINK_GRAPH_ARTEFACT,
      policy,
    ),
    latest<discovery.Reconciliation>(db, a.runId, discovery.DISCOVERY_ARTEFACT, policy),
    latest<auditCore.StructuralAudit>(db, a.runId, auditCore.STRUCTURAL_AUDIT_ARTEFACT, policy),
    latest<diagnosis.DiagnosisReport>(db, a.runId, diagnosis.DIAGNOSIS_ARTEFACT, policy),
    latest<fixes.FixRanking>(db, a.runId, fixes.FIX_RANKING_ARTEFACT, policy),
    latest<{ counts: unknown }>(db, a.runId, fixes.RESCUE_ARTEFACT, policy),
    q.listPages(db, a.runId, "crawl"),
  ]);
  return {
    id: a.runId,
    url: a.rootUrl,
    policy,
    status: a.status,
    progress: status.progress,
    durationMs: status.stages.reduce((s, x) => s + (x.durationMs ?? 0), 0),
    pages: pages.length,
    graph: g?.payload.attributes ?? null,
    discovery:
      rec === null
        ? null
        : {
            inventory: rec.payload.inventory.length,
            orphans: rec.payload.orphans.length,
            channels: rec.payload.channels,
          },
    issues: issues?.payload.summary ?? null,
    diagnosis: diag?.payload.counts ?? null,
    fixes:
      ranking === null
        ? null
        : {
            total: ranking.payload.counts.fixes,
            sigma: ranking.payload.sigmaVariant,
            top: ranking.payload.fixes.slice(0, 3),
          },
    orphans: rescue?.payload.counts ?? null,
  };
}

// ---------- sensitivity (E1) ----------

/**
 * Derive the run under all six policies and compare them: graph size, reachability, orphans,
 * issues, and the top-10 PageRank pages (compared in P3 form, where node ids of every policy
 * meet) against the audit's own policy.
 */
export async function sensitivityView(db: q.Queryable, a: q.AuditRow) {
  const run = await q.getRun(db, a.runId);
  if (run?.status !== "completed") throw notReady("the sensitivity analysis");
  const { observations, context, config } = await graph.loadRunGraphInputs(db, a.runId);
  const p3 = (n: string) => canonicalise.POLICIES.P3.canonicalise(n, context);
  const rows = [];
  for (const id of POLICIES_ORDER) {
    const derived = graph.deriveGraphFromObservations(observations, id, context, config);
    const [rec, aud] = await Promise.all([
      discovery.loadReconciliation(db, a.runId, id),
      auditCore.loadAudit(db, a.runId, id),
    ]);
    const top: [string, number][] = [];
    derived.graph.forEachNode((n, attrs) => top.push([n, attrs.pagerank ?? 0]));
    top.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    rows.push({
      policy: id,
      policyVersion: versionOf(id),
      nodes: derived.summary.nodes,
      edges: derived.summary.edges,
      reachable: derived.summary.reachable,
      largestScc: derived.summary.largestSccSize,
      orphans: rec.orphans.length,
      issues: aud.summary.total,
      issuesByType: aud.summary.byType,
      topPagerank: top.slice(0, 10).map(([n]) => n),
    });
  }
  const base = new Set((rows.find((r) => r.policy === a.policy)?.topPagerank ?? []).map(p3));
  return {
    runId: a.runId,
    baselinePolicy: a.policy,
    policies: rows.map((r) => {
      const mine = new Set(r.topPagerank.map(p3));
      const inter = [...mine].filter((n) => base.has(n)).length;
      const union = new Set([...mine, ...base]).size;
      return { ...r, top10JaccardVsBaseline: union === 0 ? 1 : inter / union };
    }),
  };
}
const POLICIES_ORDER: readonly PolicyId[] = ["P0", "P1", "P2", "P3", "P4", "P5"];

// ---------- export ----------

/** A zip with the audit's results as JSON and CSV (whatever the pipeline has produced). */
export async function exportBundle(
  db: q.Queryable,
  a: q.AuditRow,
  active: boolean,
): Promise<Uint8Array> {
  const policy = a.policy as PolicyId;
  const [status, summary, issues, diag, ranking, rescue, expl] = await Promise.all([
    auditView(db, a, active),
    summaryView(db, a, active),
    latest<auditCore.StructuralAudit>(db, a.runId, auditCore.STRUCTURAL_AUDIT_ARTEFACT, policy),
    latest<diagnosis.DiagnosisReport>(db, a.runId, diagnosis.DIAGNOSIS_ARTEFACT, policy),
    latest<fixes.FixRanking>(db, a.runId, fixes.FIX_RANKING_ARTEFACT, policy),
    latest<{ orphans: fixes.RescuedOrphan[] }>(db, a.runId, fixes.RESCUE_ARTEFACT, policy),
    latest<fixes.ExplanationSet>(db, a.runId, fixes.EXPLANATIONS_ARTEFACT, policy),
  ]);
  const json = (x: unknown) => strToU8(`${JSON.stringify(x, null, 2)}\n`);
  const files: Record<string, Uint8Array> = {
    "audit.json": json(status),
    "summary.json": json(summary),
  };
  const fixSentence = new Map((expl?.payload.fixes ?? []).map((e) => [e.id, e.sentence]));
  const diagSentence = new Map((expl?.payload.diagnoses ?? []).map((e) => [e.id, e.sentence]));
  const rescueSentence = new Map((expl?.payload.rescues ?? []).map((e) => [e.id, e.sentence]));
  if (issues !== null) {
    files["issues.json"] = json(issues.payload);
    files["issues.csv"] = strToU8(
      toCsv(issues.payload.issues, [
        ["id", (i) => i.id],
        ["type", (i) => i.type],
        ["rule", (i) => i.rule ?? null],
        ["node", (i) => i.node],
        ["severity", (i) => i.severity],
        ["evidence", (i) => i.evidence],
      ]),
    );
  }
  if (diag !== null) {
    files["diagnosis.json"] = json(diag.payload);
    files["diagnosis.csv"] = strToU8(
      toCsv(diag.payload.diagnoses, [
        ["id", (d) => d.id],
        ["case", (d) => d.case],
        ["label", (d) => d.label],
        ["source", (d) => d.source],
        ["target", (d) => d.target],
        ["ref", (d) => d.ref],
        ["rho", (d) => d.rho],
        ["omega", (d) => d.omega],
        ["severity", (d) => d.severity],
        ["recommendation", (d) => d.recommendation],
        ["explanation", (d) => diagSentence.get(d.id) ?? null],
      ]),
    );
  }
  if (ranking !== null) {
    files["fixes.json"] = json(ranking.payload);
    files["fixes.csv"] = strToU8(
      toCsv(ranking.payload.fixes, [
        ["rank", (f) => f.rank],
        ["target_rank", (f) => f.targetRank],
        ["type", (f) => f.type],
        ["donor", (f) => f.donor],
        ["target", (f) => f.target],
        ["score", (f) => f.score],
        ["delta_pr", (f) => f.deltaPr],
        ["delta_depth", (f) => f.deltaDepth],
        ["sigma_variant", (f) => f.sigmaVariant],
        ["sigma", (f) => f.sigma],
        ["ref", (f) => f.ref],
        ["cosine", (f) => f.cosine],
        ["kappa", (f) => f.kappa],
        ["policy_version", (f) => f.policyVersion],
        ["explanation", (f) => fixSentence.get(f.id) ?? null],
      ]),
    );
  }
  if (rescue !== null) {
    const rows = rescue.payload.orphans.flatMap((o) =>
      o.donors.length === 0
        ? [{ o, d: null }]
        : o.donors.map((d) => ({ o, d: d as fixes.RescueDonor | null })),
    );
    files["orphans.json"] = json(rescue.payload);
    files["orphans.csv"] = strToU8(
      toCsv(rows, [
        ["orphan", (r) => r.o.node],
        ["revealed_by", (r) => r.o.revealedBy.join(" ")],
        ["status", (r) => r.o.status],
        ["rank", (r) => r.d?.rank ?? null],
        ["donor", (r) => r.d?.donor ?? null],
        ["ref", (r) => r.d?.ref ?? null],
        ["delta_pr", (r) => r.d?.deltaPr ?? null],
        ["depth_after", (r) => r.d?.depthAfter ?? null],
        [
          "explanation",
          (r) =>
            r.d === null ? null : (rescueSentence.get(`rescue:${r.d.donor}->${r.o.node}`) ?? null),
        ],
      ]),
    );
  }
  if (expl !== null) files["explanations.json"] = json(expl.payload);
  return zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}
