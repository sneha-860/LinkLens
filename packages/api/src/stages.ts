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

/** What an audit was asked for (stored in audits.options). */
export interface AuditOptions {
  readonly sigma?: SigmaVariant;
  readonly refVariant?: semantic.RefVariant;
  /** Counterfactual worker threads (0 = automatic). */
  readonly workers?: number;
  /** Config overrides for the run (stored in runs.config). */
  readonly config?: Partial<LinkLensConfig>;
}

/** What a stage runs with (plain data: it is sent to stage workers as is). */
export interface StageCtx {
  readonly runId: number;
  readonly policy: canonicalise.PolicyId;
  readonly policyVersion: string;
  readonly options: AuditOptions;
  readonly config: Readonly<LinkLensConfig>;
}

/**
 * The stages that need only the database (no crawler, embedder or worker pool of their own):
 * these run in a stage worker thread when there is one, so the API's event loop stays free.
 */
export const DB_STAGES = [
  "extract",
  "canonicalise",
  "graph",
  "reconcile",
  "issues",
  "text",
  "ref",
  "prominence",
  "diagnosis",
  "candidates",
  "kappa",
  "scoring",
  "explanations",
] as const;
export type DbStage = (typeof DB_STAGES)[number];

export const isDbStage = (stage: string): stage is DbStage =>
  (DB_STAGES as readonly string[]).includes(stage);

const artefact = (db: q.Queryable, ctx: StageCtx, kind: string, payload: q.Json) =>
  q.insertArtefact(db, { runId: ctx.runId, policyVersion: ctx.policyVersion, kind, payload });

export const dbStages: Record<DbStage, (db: q.Queryable, ctx: StageCtx) => Promise<q.Json>> = {
  // Extraction happens during the crawl (every 2xx HTML page is parsed as it is fetched); this
  // stage records what was extracted.
  extract: async (db, ctx) => {
    const [pages, links] = await Promise.all([
      q.listPages(db, ctx.runId, "crawl"),
      q.listLinkObservations(db, ctx.runId),
    ]);
    const byRegion: Record<string, number> = {};
    for (const l of links)
      byRegion[l.domRegion ?? "none"] = (byRegion[l.domRegion ?? "none"] ?? 0) + 1;
    const summary = { pages: pages.length, linkObservations: links.length, byRegion };
    await artefact(db, ctx, "extraction-summary", summary);
    return summary;
  },

  canonicalise: async (db, ctx) => {
    const { observations, context } = await graph.loadRunGraphInputs(db, ctx.runId);
    const policy = canonicalise.POLICIES[ctx.policy];
    const nodes = new Set(observations.pages.map((p) => policy.canonicalise(p.url, context)));
    const summary = {
      policyVersion: policy.version,
      pages: observations.pages.length,
      nodes: nodes.size,
      merged: observations.pages.length - nodes.size,
      redirects: context.redirects.size,
      canonicals: context.canonicals.size,
    };
    await artefact(db, ctx, "canonicalisation", summary);
    return summary;
  },

  graph: async (db, ctx) => {
    const g = await graph.deriveGraph(db, ctx.runId, ctx.policy);
    return { nodes: g.summary.nodes, edges: g.summary.edges, reachable: g.summary.reachable };
  },

  reconcile: async (db, ctx) => {
    const r = await discovery.reconcileDiscovery(db, ctx.runId, ctx.policy);
    return { inventory: r.inventory.length, orphans: r.orphans.length };
  },

  issues: async (db, ctx) => {
    const a = await auditCore.auditRun(db, ctx.runId, ctx.policy);
    return { total: a.summary.total, byType: a.summary.byType };
  },

  text: async (db, ctx) => {
    const t = await text.buildTextRun(db, ctx.runId, ctx.policy);
    return { ...t.stats };
  },

  ref: async (db, ctx) => {
    const r = await semantic.buildRefRun(
      db,
      ctx.runId,
      ctx.policy,
      ctx.options.refVariant ?? "weighted",
    );
    return { ...r.stats };
  },

  prominence: async (db, ctx) => {
    const p = await prominence.buildProminenceRun(db, ctx.runId, ctx.policy);
    return { edges: p.stats.edges, analytics: p.stats.analytics };
  },

  diagnosis: async (db, ctx) => {
    const d = await diagnosis.buildDiagnosisRun(
      db,
      ctx.runId,
      ctx.policy,
      ctx.options.refVariant ?? "weighted",
    );
    return d.counts;
  },

  candidates: async (db, ctx) => {
    const c = await fixes.buildCandidatesRun(
      db,
      ctx.runId,
      ctx.policy,
      ctx.options.refVariant ?? "weighted",
    );
    return { targets: c.stats.targets, candidates: c.stats.candidates, byAction: c.stats.byAction };
  },

  kappa: async (db, ctx) => {
    const effort = await fixes.loadDonorEffort(db, ctx.runId, ctx.policy);
    const nodes = [...effort.values()].sort((a, b) => (a.node < b.node ? -1 : 1));
    await artefact(db, ctx, "donor-effort", { nodes } as unknown as q.Json);
    return {
      pages: nodes.length,
      maxKappa: Math.max(1, ...nodes.map((n) => n.kappa)),
      templatedDonors: nodes.filter((n) => n.templateReach > 1).length,
    };
  },

  scoring: async (db, ctx) => {
    const r = await fixes.buildFixRanking(db, ctx.runId, ctx.policy, {
      sigmaVariant: ctx.options.sigma ?? ctx.config.sigmaVariant,
    });
    return { fixes: r.counts.fixes, targets: r.counts.targets, sigma: r.sigmaVariant };
  },

  explanations: async (db, ctx) => {
    const e = await fixes.buildExplanations(db, ctx.runId, ctx.policy);
    return e.counts;
  },
};
