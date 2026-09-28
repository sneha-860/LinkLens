import { zipSync, strToU8 } from "fflate";
import {
  audit as auditCore,
  canonicalise,
  db as q,
  diagnosis,
  discovery,
  fixes,
  graph,
  importance,
  makeConfig,
  rating,
  type SigmaVariant,
} from "@linklens/core";
import { toCsv } from "./csv.js";
import { HttpError, notFound, notReady } from "./errors.js";
import { STAGES, type PolicyJob } from "./pipeline.js";
import { stats } from "@linklens/core";

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

/**
 * The policy's link graph, with each node's page type and importance (L12; from the stored
 * `page-importance` artefact, computed once when missing; null until the crawl has completed).
 */
export async function graphView(db: q.Queryable, a: q.AuditRow, policy: PolicyId) {
  let row = await latest<q.Json>(db, a.runId, graph.LINK_GRAPH_ARTEFACT, policy);
  const run = await q.getRun(db, a.runId);
  if (row === null) {
    if (run?.status !== "completed") throw notReady("the link graph");
    const g = await graph.deriveGraph(db, a.runId, policy);
    row = { id: g.artefact.id, payload: g.artefact.payload };
  }
  const pageImportance =
    run?.status === "completed" ? await importance.importanceFor(db, a.runId, policy) : null;
  return {
    policy,
    policyVersion: versionOf(policy),
    artefactId: row.id,
    graph: row.payload,
    importance: pageImportance?.nodes ?? null,
  };
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

/**
 * Broken internal links and redirect chains, from the recorded crawl fetches (computed on
 * request; available once the crawl stage has completed).
 */
export async function linksView(db: q.Queryable, a: q.AuditRow) {
  const stages = await q.listAuditStages(db, a.runId);
  if (stages.find((s) => s.stage === "crawl")?.status !== "completed") throw notReady("the crawl");
  return auditCore.loadLinkHealth(db, a.runId, a.policy as PolicyId);
}

/**
 * The ranking for a σ variant under the run's scoring mode (config.fixScoring: S, or S_imp):
 * stored, or computed from the stored counterfactual. Rankings stored before scoring@1.2.0 are S.
 */
export async function rankingFor(db: q.Queryable, a: q.AuditRow, sigma: SigmaVariant) {
  const policy = a.policy as PolicyId;
  const scoring = makeConfig((await q.getRun(db, a.runId))?.config ?? {}).fixScoring;
  const stored = await latest<fixes.FixRanking>(
    db,
    a.runId,
    fixes.FIX_RANKING_ARTEFACT,
    policy,
    (p) => p.sigmaVariant === sigma && (p.scoring ?? "S") === scoring,
  );
  if (stored !== null) return stored;
  const stages = await q.listAuditStages(db, a.runId);
  if (stages.find((s) => s.stage === "counterfactual")?.status !== "completed") {
    throw notReady("fix scoring");
  }
  const r = await fixes.buildFixRanking(db, a.runId, policy, { sigmaVariant: sigma });
  return { id: r.artefact.id, payload: r as fixes.FixRanking };
}

/** What a fix card shows: the sentence, the lines and the anchor suggestion (null if none). */
const cardOf = (e: fixes.FixExplanation) => ({
  sentence: e.sentence,
  lines: e.lines,
  anchor: e.anchor ?? null,
});

export async function fixesView(
  db: q.Queryable,
  a: q.AuditRow,
  sigma: SigmaVariant,
  k: number,
  scope: "global" | "target",
  scoring: "formula" | "learned" = "formula",
) {
  const ranking = await rankingFor(db, a, sigma);
  // L13: the model's priority and SHAP contributions ride along on every fix when imported;
  // "learned" also reorders by them (S stays the default).
  const learned = await latest<fixes.LearnedPriority>(
    db,
    a.runId,
    fixes.LEARNED_ARTEFACT,
    a.policy as PolicyId,
  );
  if (scoring === "learned" && learned === null) {
    throw new HttpError(
      409,
      "not_ready",
      "No learned priority for this audit: train the L13 model and import it (`l13 import`)",
    );
  }
  const expl = await latest<fixes.ExplanationSet>(
    db,
    a.runId,
    fixes.EXPLANATIONS_ARTEFACT,
    a.policy as PolicyId,
  );
  const byId = new Map((expl?.payload.fixes ?? []).map((e) => [e.id, e]));
  const withExplanation = (f: fixes.FixRecord | fixes.LearnedFixRecord) => {
    const e = byId.get(f.id);
    return {
      ...f,
      learned: learned?.payload.fixes[f.id] ?? null,
      explanation: e === undefined ? null : cardOf(e),
    };
  };
  const all: readonly (fixes.FixRecord | fixes.LearnedFixRecord)[] =
    scoring === "learned" && learned !== null
      ? fixes.applyLearned(ranking.payload.fixes, learned.payload)
      : ranking.payload.fixes;
  return {
    sigma,
    k,
    scope,
    scoring,
    artefactId: ranking.id,
    learnedArtefactId: learned?.id ?? null,
    learnedModel: learned?.payload.model ?? null,
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

/**
 * The rating page: the latest blind sample (no ranks or scores) and, for `rater`, only that
 * rater's own latest answers (never the other rater's).
 */
export async function ratingView(db: q.Queryable, a: q.AuditRow, rater?: q.Rater) {
  const policy = a.policy as PolicyId;
  const sample = await rating.loadRatingSample(db, a.runId, policy);
  if (sample === null) {
    const ranking = await latest(db, a.runId, fixes.FIX_RANKING_ARTEFACT, policy);
    return { sample: null, canCreate: ranking !== null };
  }
  const mine =
    rater === undefined
      ? new Map<string, rating.Answer>()
      : (rating.latestAnswers(await q.listFixRatings(db, sample.artefactId)).get(rater) ??
        new Map<string, rating.Answer>());
  return {
    sample: {
      id: sample.artefactId,
      version: sample.version,
      size: sample.size,
      pool: sample.pool,
      sigmaVariant: sample.sigmaVariant,
      items: rating.blindItems(sample.items),
    },
    canCreate: false,
    rater: rater ?? null,
    name: [...mine.values()].at(-1)?.raterName ?? null,
    answers: Object.fromEntries(
      [...mine].map(([id, x]) => [id, { relevant: x.relevant, placement: x.placement }]),
    ),
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
          explanation: e === undefined ? null : cardOf(e),
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

// ---------- reconciliation ----------

/** The discovery inventory under the audit's policy: each URL's channels, and channel yields. */
export async function reconciliationView(db: q.Queryable, a: q.AuditRow) {
  const row = await latest<discovery.Reconciliation>(
    db,
    a.runId,
    discovery.DISCOVERY_ARTEFACT,
    a.policy as PolicyId,
  );
  if (row === null) throw notReady("the reconciliation");
  const r = row.payload;
  return {
    policy: a.policy,
    artefactId: row.id,
    channels: r.channels,
    orphans: r.orphans.length,
    inventory: r.inventory
      .map((e) => ({
        node: e.node,
        channels: e.channels,
        urls: e.urls,
        reachable: e.reachable,
        depth: e.depth,
        orphan: e.orphan,
      }))
      .sort((x, y) => Number(y.orphan) - Number(x.orphan) || (x.node < y.node ? -1 : 1)),
  };
}

// ---------- sensitivity (E1) ----------

/** The six policies compared with the audit's (core stats.compareRunPolicies), with the job. */
export async function sensitivityView(
  db: q.Queryable,
  a: q.AuditRow,
  k: number,
  job: PolicyJob | null,
) {
  const run = await q.getRun(db, a.runId);
  if (run?.status !== "completed") throw notReady("the sensitivity analysis");
  const result = await stats.compareRunPolicies(
    db,
    a.runId,
    a.policy as PolicyId,
    k,
    a.options["sigma"] as SigmaVariant | undefined,
  );
  return { ...result, fixesJob: job };
}

// ---------- export ----------

/** A zip with the audit's results as JSON and CSV (whatever the pipeline has produced). */
export async function exportBundle(
  db: q.Queryable,
  a: q.AuditRow,
  active: boolean,
): Promise<Uint8Array> {
  return zipSync(await exportFiles(db, a, active), {
    level: 6,
    mtime: new Date("2026-01-01T00:00:00Z"),
  });
}

/** The export's files by name (audit.json, fixes.csv, …); the zip holds all of them. */
export async function exportFiles(
  db: q.Queryable,
  a: q.AuditRow,
  active: boolean,
): Promise<Record<string, Uint8Array>> {
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
  const fixAnchor = new Map(
    (expl?.payload.fixes ?? []).map((e) => [
      e.id,
      e.anchor?.status === "suggested" ? e.anchor : null,
    ]),
  );
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
        ["suggested_anchor", (f) => fixAnchor.get(f.id)?.anchor ?? null],
        [
          "anchor_paragraph",
          (f) => {
            const a = fixAnchor.get(f.id);
            return a === null || a === undefined ? null : a.paragraphIndex + 1;
          },
        ],
        ["anchor_ref", (f) => fixAnchor.get(f.id)?.ref ?? null],
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
  const crawled =
    (await q.listAuditStages(db, a.runId)).find((s) => s.stage === "crawl")?.status === "completed";
  if (crawled) {
    const health = await auditCore.loadLinkHealth(db, a.runId, policy);
    const hops = (t: auditCore.RedirectChain | auditCore.BrokenTarget) =>
      [
        ...t.chain.map((h) => `${h.url} (${h.statusCode})`),
        `${t.finalUrl ?? ""} (${t.finalStatus ?? ""})`,
      ].join(" -> ");
    // One row per source page and target: where to fix the link.
    files["broken-links.csv"] = strToU8(
      toCsv(
        health.broken.flatMap((t) => t.sources.map((s) => ({ t, s }))),
        [
          ["source_url", (r) => r.s.page],
          ["target_url", (r) => r.t.url],
          ["status", (r) => r.t.finalStatus],
          ["class", (r) => r.t.class],
          ["redirect_hops", (r) => r.t.hops],
          ["final_url", (r) => r.t.finalUrl],
          ["links", (r) => r.s.links],
          ["anchors", (r) => r.s.anchors.join(" | ")],
          ["regions", (r) => r.s.regions.join(" ")],
        ],
      ),
    );
    files["redirect-chains.csv"] = strToU8(
      toCsv(
        health.redirectChains.flatMap((t) => t.sources.map((s) => ({ t, s }))),
        [
          ["source_url", (r) => r.s.page],
          ["target_url", (r) => r.t.url],
          ["hops", (r) => r.t.hops],
          ["chain", (r) => hops(r.t)],
          ["final_url", (r) => r.t.finalUrl],
          ["final_status", (r) => r.t.finalStatus],
          ["ends_broken", (r) => (r.t.endsBroken ? 1 : 0)],
          ["links", (r) => r.s.links],
          ["anchors", (r) => r.s.anchors.join(" | ")],
        ],
      ),
    );
  }
  const sample = await rating.loadRatingSample(db, a.runId, policy);
  if (sample !== null) {
    const rows = await q.listFixRatings(db, sample.artefactId);
    const rankOf = new Map(sample.items.map((i) => [i.itemId, i.rank]));
    // Every answer (append-only history) with the item's rank, which the raters never saw.
    files["ratings.csv"] = strToU8(
      toCsv(rows, [
        ["sample_id", (r) => r.sampleArtefactId],
        ["item_id", (r) => r.itemId],
        ["rank", (r) => rankOf.get(r.itemId) ?? null],
        ["rater", (r) => r.rater],
        ["rater_name", (r) => r.raterName],
        ["relevant", (r) => (r.relevant ? 1 : 0)],
        ["placement", (r) => r.placement],
        ["rated_at", (r) => new Date(r.ratedAt).toISOString()],
      ]),
    );
  }
  return files;
}
