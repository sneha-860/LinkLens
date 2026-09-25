import { EventEmitter } from "node:events";
import type pg from "pg";
import {
  audit as auditCore,
  canonicalise,
  db as q,
  diagnosis,
  discovery,
  fixes,
  graph,
  makeConfig,
  prominence,
  semantic,
  text,
  type LinkLensConfig,
  type SigmaVariant,
} from "@linklens/core";
import { asQueryable } from "@linklens/db";
import { CrawlOrchestrator, DiscoveryRunner, RescueFetcher } from "@linklens/crawler";
import { buildCosineRun, type Embedder, type EmbeddingOptions } from "@linklens/embeddings";
import { buildCounterfactualRun, buildRescueRun } from "@linklens/counterfactual";

/** The pipeline, in order. Every stage stores its artefacts with the audit's policy version. */
export const STAGES = [
  "crawl",
  "extract",
  "discovery",
  "canonicalise",
  "graph",
  "reconcile",
  "issues",
  "text",
  "ref",
  "embeddings",
  "prominence",
  "diagnosis",
  "candidates",
  "counterfactual",
  "kappa",
  "scoring",
  "rescue",
  "explanations",
] as const;
export type Stage = (typeof STAGES)[number];

/** What an audit was asked for (stored in audits.options). */
export interface AuditOptions {
  readonly sigma?: SigmaVariant;
  readonly refVariant?: semantic.RefVariant;
  /** Counterfactual worker threads (0 = automatic). */
  readonly workers?: number;
  /** Config overrides for the run (stored in runs.config). */
  readonly config?: Partial<LinkLensConfig>;
}

export type PipelineEvent =
  | {
      readonly type: "stage";
      readonly runId: number;
      readonly stage: Stage;
      readonly status: "running";
    }
  | {
      readonly type: "stage";
      readonly runId: number;
      readonly stage: Stage;
      readonly status: "completed";
      readonly durationMs: number;
      readonly detail: q.Json;
    }
  | {
      readonly type: "stage";
      readonly runId: number;
      readonly stage: Stage;
      readonly status: "failed";
      readonly durationMs: number;
      readonly error: string;
    }
  | {
      readonly type: "progress";
      readonly runId: number;
      readonly pagesFetched: number;
      readonly admitted: number;
      readonly queueSize: number;
      readonly url: string;
    }
  | {
      readonly type: "done";
      readonly runId: number;
      readonly status: "completed" | "failed";
      readonly error?: string;
    };

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface PipelineDeps {
  readonly pool: pg.Pool;
  readonly redisUrl: string;
  /** Redis prefix shared by the crawl, discovery and rescue (per-host throttle). */
  readonly prefix?: string;
  readonly fetch?: typeof fetch;
  /** Creates the embedder for an audit (the MiniLM worker in production; a stub in tests). */
  readonly embedder: (options: EmbeddingOptions) => Embedder & { close?(): Promise<void> };
  /** Cache root for embeddings and model files. */
  readonly cacheDir: string;
  readonly logger?: Logger;
  /**
   * Config applied to every new audit under its own overrides (e.g. the deployment's
   * User-Agent with a real contact URL).
   */
  readonly defaultConfig?: Partial<LinkLensConfig>;
  /** Called before each stage runs (tests use it to inject failures). */
  readonly beforeStage?: (runId: number, stage: Stage) => Promise<void> | void;
}

export interface CreateAuditInput {
  readonly url: string;
  readonly pageCap?: number;
  readonly policy: canonicalise.PolicyId;
  readonly options?: AuditOptions;
}

interface Ctx {
  readonly runId: number;
  readonly policy: canonicalise.PolicyId;
  readonly policyVersion: string;
  readonly options: AuditOptions;
  readonly config: Readonly<LinkLensConfig>;
}

type StageFn = (ctx: Ctx) => Promise<q.Json>;

const silent: Logger = { info: () => undefined, error: () => undefined };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs audits through the pipeline in this process. Each stage is recorded in audit_stages
 * (status, start, finish, duration, detail); `run` starts from the first stage not completed, so
 * a failed or interrupted audit resumes where it stopped. Events (stage changes, crawl progress,
 * completion) are emitted as "event" for server-sent events.
 */
export class PipelineRunner extends EventEmitter {
  readonly db: q.Queryable;
  readonly orchestrator: CrawlOrchestrator;
  private readonly logger: Logger;
  private readonly active = new Map<number, Promise<void>>();

  constructor(private readonly deps: PipelineDeps) {
    super();
    this.db = asQueryable(deps.pool);
    this.logger = deps.logger ?? silent;
    this.orchestrator = new CrawlOrchestrator({
      pool: deps.pool,
      redisUrl: deps.redisUrl,
      ...(deps.prefix === undefined ? {} : { prefix: deps.prefix }),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  }

  /** Create the run and the audit, then start the pipeline in the background. */
  async create(input: CreateAuditInput): Promise<q.AuditRow> {
    const options = input.options ?? {};
    const config = {
      ...this.deps.defaultConfig,
      ...options.config,
      ...(input.pageCap === undefined ? {} : { pageCap: input.pageCap }),
    };
    const { runId } = await this.orchestrator.createRun(input.url, { config });
    const audit = await q.insertAudit(this.db, {
      runId,
      policy: input.policy,
      options: options as { [key: string]: q.Json },
      stages: STAGES,
    });
    this.start(runId);
    return audit;
  }

  /** Is the pipeline of this audit running in this process? */
  isActive(runId: number): boolean {
    return this.active.has(runId);
  }

  /** Run (or resume) an audit in the background; a no-op if it is already running here. */
  start(runId: number): Promise<void> {
    let p = this.active.get(runId);
    if (p === undefined) {
      p = this.run(runId).finally(() => this.active.delete(runId));
      this.active.set(runId, p);
    }
    return p;
  }

  /** Resume every audit a previous process left running. */
  async recover(): Promise<number[]> {
    const ids = (await q.listRunningAudits(this.db)).map((a) => a.runId);
    for (const id of ids) void this.start(id);
    return ids;
  }

  /** Re-run `stage` and everything after it (e.g. after an analytics upload). */
  async rerunFrom(runId: number, stage: Stage): Promise<void> {
    await q.resetStages(this.db, runId, STAGES.indexOf(stage));
    await q.setAuditStatus(this.db, runId, { status: "queued", currentStage: stage });
    void this.start(runId);
  }

  /** Stop in-process work (crawls stay resumable) and disconnect. */
  async close(): Promise<void> {
    await this.orchestrator.shutdown();
  }

  private emitEvent(e: PipelineEvent): void {
    this.emit("event", e);
  }

  private async run(runId: number): Promise<void> {
    const audit = await q.getAudit(this.db, runId);
    if (audit === null) throw new Error(`audit ${runId} not found`);
    const run = await q.getRun(this.db, runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    const policy = audit.policy as canonicalise.PolicyId;
    const ctx: Ctx = {
      runId,
      policy,
      policyVersion: canonicalise.POLICIES[policy].version,
      options: audit.options as AuditOptions,
      config: makeConfig(run.config),
    };
    const stages = await q.listAuditStages(this.db, runId);
    await q.setAuditStatus(this.db, runId, { status: "running", error: null });
    try {
      for (const row of stages) {
        if (row.status === "completed") continue;
        await this.runStage(ctx, row.stage as Stage);
      }
      await q.setAuditStatus(this.db, runId, { status: "completed", currentStage: null });
      this.logger.info(`[audit ${runId}] completed`);
      this.emitEvent({ type: "done", runId, status: "completed" });
    } catch (e) {
      const error = errorText(e);
      await q.setAuditStatus(this.db, runId, { status: "failed", error });
      this.logger.error(`[audit ${runId}] failed: ${error}`);
      this.emitEvent({ type: "done", runId, status: "failed", error });
    }
  }

  private async runStage(ctx: Ctx, stage: Stage): Promise<void> {
    const { runId } = ctx;
    await q.setAuditStatus(this.db, runId, { status: "running", currentStage: stage });
    await q.startStage(this.db, runId, stage);
    this.emitEvent({ type: "stage", runId, stage, status: "running" });
    const started = performance.now();
    try {
      await this.deps.beforeStage?.(runId, stage);
      const detail = await this.stages[stage](ctx);
      const durationMs = performance.now() - started;
      await q.finishStage(this.db, runId, stage, {
        durationMs,
        detail: (detail ?? {}) as { [key: string]: q.Json },
      });
      this.logger.info(`[audit ${runId}] ${stage} completed in ${durationMs.toFixed(0)} ms`);
      this.emitEvent({ type: "stage", runId, stage, status: "completed", durationMs, detail });
    } catch (e) {
      const durationMs = performance.now() - started;
      const error = errorText(e);
      await q.failStage(this.db, runId, stage, { durationMs, error });
      this.logger.error(
        `[audit ${runId}] ${stage} failed after ${durationMs.toFixed(0)} ms: ${error}`,
      );
      this.emitEvent({ type: "stage", runId, stage, status: "failed", durationMs, error });
      throw e;
    }
  }

  private artefact(ctx: Ctx, kind: string, payload: q.Json) {
    return q.insertArtefact(this.db, {
      runId: ctx.runId,
      policyVersion: ctx.policyVersion,
      kind,
      payload,
    });
  }

  private readonly stages: Record<Stage, StageFn> = {
    crawl: async (ctx) => {
      const run = await q.getRun(this.db, ctx.runId);
      if (run?.status === "completed") return { skipped: "already crawled" };
      const handle =
        run?.status === "running"
          ? await this.orchestrator.resume(ctx.runId)
          : await this.orchestrator.start(ctx.runId);
      handle.on(
        "progress",
        (p: { pagesFetched: number; admitted: number; queueSize: number; url: string }) =>
          this.emitEvent({
            type: "progress",
            runId: ctx.runId,
            pagesFetched: p.pagesFetched,
            admitted: p.admitted,
            queueSize: p.queueSize,
            url: p.url,
          }),
      );
      const summary = await handle.done;
      if (summary.status !== "completed") {
        throw new Error(
          `crawl ${summary.status}${summary.error === undefined ? "" : `: ${summary.error}`}`,
        );
      }
      return { pagesFetched: summary.pagesFetched, admitted: summary.admitted };
    },

    // Extraction happens during the crawl (every 2xx HTML page is parsed as it is fetched); this
    // stage records what was extracted.
    extract: async (ctx) => {
      const [pages, links] = await Promise.all([
        q.listPages(this.db, ctx.runId, "crawl"),
        q.listLinkObservations(this.db, ctx.runId),
      ]);
      const byRegion: Record<string, number> = {};
      for (const l of links)
        byRegion[l.domRegion ?? "none"] = (byRegion[l.domRegion ?? "none"] ?? 0) + 1;
      const summary = { pages: pages.length, linkObservations: links.length, byRegion };
      await this.artefact(ctx, "extraction-summary", summary);
      return summary;
    },

    discovery: async (ctx) => {
      const runner = new DiscoveryRunner(this.shared());
      try {
        const s = await runner.run(ctx.runId);
        return { fetches: s.fetches, capReached: s.capReached, observations: s.observations };
      } finally {
        await runner.close();
      }
    },

    canonicalise: async (ctx) => {
      const { observations, context } = await graph.loadRunGraphInputs(this.db, ctx.runId);
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
      await this.artefact(ctx, "canonicalisation", summary);
      return summary;
    },

    graph: async (ctx) => {
      const g = await graph.deriveGraph(this.db, ctx.runId, ctx.policy);
      return { nodes: g.summary.nodes, edges: g.summary.edges, reachable: g.summary.reachable };
    },

    reconcile: async (ctx) => {
      const r = await discovery.reconcileDiscovery(this.db, ctx.runId, ctx.policy);
      return { inventory: r.inventory.length, orphans: r.orphans.length };
    },

    issues: async (ctx) => {
      const a = await auditCore.auditRun(this.db, ctx.runId, ctx.policy);
      return { total: a.summary.total, byType: a.summary.byType };
    },

    text: async (ctx) => {
      const t = await text.buildTextRun(this.db, ctx.runId, ctx.policy);
      return { ...t.stats };
    },

    ref: async (ctx) => {
      const r = await semantic.buildRefRun(
        this.db,
        ctx.runId,
        ctx.policy,
        ctx.options.refVariant ?? "weighted",
      );
      return { ...r.stats };
    },

    embeddings: async (ctx) => {
      const embedder = this.deps.embedder({
        model: ctx.config.embeddingModel,
        dtype: ctx.config.embeddingDtype,
        bodyTokens: ctx.config.embeddingBodyTokens,
        batchSize: ctx.config.embeddingBatchSize,
        cacheDir: this.deps.cacheDir,
      });
      try {
        const m = await buildCosineRun(this.db, ctx.runId, ctx.policy, embedder);
        return { nodes: m.nodes.length, dimensions: m.dimensions, cache: m.cache };
      } finally {
        await embedder.close?.();
      }
    },

    prominence: async (ctx) => {
      const p = await prominence.buildProminenceRun(this.db, ctx.runId, ctx.policy);
      return { edges: p.stats.edges, analytics: p.stats.analytics };
    },

    diagnosis: async (ctx) => {
      const d = await diagnosis.buildDiagnosisRun(
        this.db,
        ctx.runId,
        ctx.policy,
        ctx.options.refVariant ?? "weighted",
      );
      return d.counts;
    },

    candidates: async (ctx) => {
      const c = await fixes.buildCandidatesRun(
        this.db,
        ctx.runId,
        ctx.policy,
        ctx.options.refVariant ?? "weighted",
      );
      return {
        targets: c.stats.targets,
        candidates: c.stats.candidates,
        byAction: c.stats.byAction,
      };
    },

    counterfactual: async (ctx) => {
      const r = await buildCounterfactualRun(this.db, ctx.runId, ctx.policy, {
        variant: ctx.options.refVariant ?? "weighted",
        ...(ctx.options.workers === undefined ? {} : { workers: ctx.options.workers }),
      });
      return {
        candidates: r.stats.candidates,
        validation: r.validation.passed,
        wallMs: r.runtime.wallMs,
        workers: r.runtime.workers,
      };
    },

    kappa: async (ctx) => {
      const effort = await fixes.loadDonorEffort(this.db, ctx.runId, ctx.policy);
      const nodes = [...effort.values()].sort((a, b) => (a.node < b.node ? -1 : 1));
      await this.artefact(ctx, "donor-effort", { nodes } as unknown as q.Json);
      return {
        pages: nodes.length,
        maxKappa: Math.max(1, ...nodes.map((n) => n.kappa)),
        templatedDonors: nodes.filter((n) => n.templateReach > 1).length,
      };
    },

    scoring: async (ctx) => {
      const r = await fixes.buildFixRanking(this.db, ctx.runId, ctx.policy, {
        sigmaVariant: ctx.options.sigma ?? ctx.config.sigmaVariant,
      });
      return { fixes: r.counts.fixes, targets: r.counts.targets, sigma: r.sigmaVariant };
    },

    rescue: async (ctx) => {
      const fetcher = new RescueFetcher(this.shared());
      try {
        const f = await fetcher.run(ctx.runId, ctx.policy);
        const r = await buildRescueRun(this.db, ctx.runId, ctx.policy, {
          variant: ctx.options.refVariant ?? "weighted",
          ...(ctx.options.workers === undefined ? {} : { workers: ctx.options.workers }),
        });
        return { fetched: f.pages, ...r.counts };
      } finally {
        await fetcher.close();
      }
    },

    explanations: async (ctx) => {
      const e = await fixes.buildExplanations(this.db, ctx.runId, ctx.policy);
      return e.counts;
    },
  };

  private shared() {
    return {
      pool: this.deps.pool,
      redisUrl: this.deps.redisUrl,
      ...(this.deps.prefix === undefined ? {} : { prefix: this.deps.prefix }),
      ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch }),
    };
  }
}
