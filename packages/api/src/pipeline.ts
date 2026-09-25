import type pg from "pg";
import { canonicalise, db as q, fixes, makeConfig, type LinkLensConfig } from "@linklens/core";
import { asQueryable } from "@linklens/db";
import { CrawlOrchestrator, DiscoveryRunner, RescueFetcher } from "@linklens/crawler";
import { buildCosineRun, type Embedder, type EmbeddingOptions } from "@linklens/embeddings";
import { buildCounterfactualRun, buildRescueRun } from "@linklens/counterfactual";
import { CapacityError } from "./errors.js";
import { RedisEventBus, type EventBus, type EventListener } from "./events.js";
import { RedisLeases, type Leases } from "./leases.js";
import { StageWorkerPool } from "./stage-pool.js";
import { dbStages, isDbStage, type AuditOptions, type DbStage, type StageCtx } from "./stages.js";

export type { AuditOptions } from "./stages.js";
export { CapacityError } from "./errors.js";

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

/** The stages that rank fixes under a policy (no crawl, discovery, rescue or explanations). */
export const RANKING_STAGES: readonly Stage[] = [
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
  "scoring",
];

/** Background ranking of fixes under every other policy (for the sensitivity table). */
export interface PolicyJob {
  status: "running" | "completed" | "failed";
  /** Policies with a ranking (already there or computed by this job). */
  done: string[];
  current: string | null;
  error: string | null;
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
   * User-Agent with a real contact URL). Its api* settings configure this runner.
   */
  readonly defaultConfig?: Partial<LinkLensConfig>;
  /** Called before each stage runs (tests use it to inject failures). */
  readonly beforeStage?: (runId: number, stage: Stage) => Promise<void> | void;
  /**
   * The database URL for stage worker threads (each opens its own pool). Without it, or with
   * config.apiStageWorkers = 0, every stage runs on the main thread.
   */
  readonly databaseUrl?: string;
  /** Pipeline events (default: Redis pub/sub, shared by every instance). */
  readonly bus?: EventBus;
  /** Who runs which audit (default: leases in Redis). */
  readonly leases?: Leases;
}

export interface CreateAuditInput {
  readonly url: string;
  readonly pageCap?: number;
  readonly policy: canonicalise.PolicyId;
  readonly options?: AuditOptions;
}

type Ctx = StageCtx;
type StageFn = (ctx: Ctx) => Promise<q.Json>;

const silent: Logger = { info: () => undefined, error: () => undefined };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs audits through the pipeline. Each stage is recorded in audit_stages (status, start,
 * finish, duration, detail); `run` starts from the first stage not completed, so a failed or
 * interrupted audit resumes where it stopped. An audit runs under a lease (leases.ts), so with
 * several instances each audit runs in exactly one, and every instance can tell it is active.
 * Events (stage changes, crawl progress, completion) go to the event bus, for server-sent events.
 */
export class PipelineRunner {
  readonly db: q.Queryable;
  readonly orchestrator: CrawlOrchestrator;
  /** The deployment's settings (config under defaultConfig): concurrency, leases, workers. */
  readonly settings: Readonly<LinkLensConfig>;
  private readonly logger: Logger;
  private readonly bus: EventBus;
  private readonly leases: Leases;
  private readonly stagePool: StageWorkerPool | null;
  private readonly active = new Map<number, Promise<void>>();
  private readonly policyJobs = new Map<number, Promise<void>>();

  constructor(private readonly deps: PipelineDeps) {
    this.db = asQueryable(deps.pool);
    this.logger = deps.logger ?? silent;
    this.settings = makeConfig(deps.defaultConfig);
    const prefix = deps.prefix ?? "linklens";
    const onError = (m: string) => this.logger.error(m);
    this.bus = deps.bus ?? new RedisEventBus(deps.redisUrl, prefix, onError);
    this.leases =
      deps.leases ?? new RedisLeases(deps.redisUrl, prefix, this.settings.apiAuditLeaseMs, onError);
    this.stagePool =
      deps.databaseUrl !== undefined && this.settings.apiStageWorkers > 0
        ? new StageWorkerPool(this.settings.apiStageWorkers, deps.databaseUrl)
        : null;
    this.orchestrator = new CrawlOrchestrator({
      pool: deps.pool,
      redisUrl: deps.redisUrl,
      ...(deps.prefix === undefined ? {} : { prefix: deps.prefix }),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  }

  /** Audits and policy jobs running in this instance. */
  activeCount(): number {
    return this.active.size + this.policyJobs.size;
  }

  /** Throws CapacityError when this instance is at config.apiMaxConcurrentAudits. */
  assertCapacity(): void {
    if (this.activeCount() >= this.settings.apiMaxConcurrentAudits)
      throw new CapacityError(this.settings.apiMaxConcurrentAudits);
  }

  /** Create the run and the audit, then start the pipeline in the background. */
  async create(input: CreateAuditInput): Promise<q.AuditRow> {
    this.assertCapacity();
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
    void this.start(runId);
    return audit;
  }

  /** Is this audit's pipeline running, here or in another instance? */
  async isActive(runId: number): Promise<boolean> {
    return this.active.has(runId) || (await this.leases.isHeld(`audit:${runId}`));
  }

  /**
   * Run (or resume) an audit in the background. A no-op if it is already running here; returns
   * at once if another instance holds its lease.
   */
  start(runId: number): Promise<void> {
    let p = this.active.get(runId);
    if (p === undefined) {
      p = this.leased(`audit:${runId}`, () => this.run(runId)).finally(() =>
        this.active.delete(runId),
      );
      this.active.set(runId, p);
    }
    return p;
  }

  /** Run `fn` holding the lease `key`; skip it if another instance holds the lease. */
  private async leased(key: string, fn: () => Promise<void>): Promise<void> {
    if (!(await this.leases.acquire(key))) {
      this.logger.info(`${key} is running in another instance`);
      return;
    }
    try {
      await fn();
    } finally {
      await this.leases.release(key).catch(() => undefined);
    }
  }

  /**
   * Resume what a stopped instance left running (audits, then policy jobs), up to this
   * instance's capacity; what a live instance still holds is left to it.
   */
  async recover(): Promise<{ audits: number[]; policyJobs: number[] }> {
    const audits: number[] = [];
    const policyJobs: number[] = [];
    const room = () => this.activeCount() < this.settings.apiMaxConcurrentAudits;
    for (const a of await q.listRunningAudits(this.db)) {
      if (!room()) break;
      if (await this.leases.isHeld(`audit:${a.runId}`)) continue;
      void this.start(a.runId);
      audits.push(a.runId);
    }
    for (const j of await q.listRunningPolicyJobs(this.db)) {
      if (!room()) break;
      if (await this.leases.isHeld(`policy:${j.runId}`)) continue;
      void this.runPolicyJob(j.runId);
      policyJobs.push(j.runId);
    }
    return { audits, policyJobs };
  }

  /** Re-run `stage` and everything after it (e.g. after an analytics upload). */
  async rerunFrom(runId: number, stage: Stage): Promise<void> {
    this.assertCapacity();
    await q.resetStages(this.db, runId, STAGES.indexOf(stage));
    await q.setAuditStatus(this.db, runId, { status: "queued", currentStage: stage });
    void this.start(runId);
  }

  /** The per-policy ranking job of an audit (stored in policy_jobs), if any. */
  async policyJob(runId: number): Promise<PolicyJob | null> {
    const row = await q.getPolicyJob(this.db, runId);
    return row === null
      ? null
      : { status: row.status, done: row.done, current: row.current, error: row.error };
  }

  /**
   * Rank fixes under every policy that lacks a ranking for the audit's σ, in the background:
   * the ranking stages run with that policy (their artefacts carry its version). The job is
   * stored in policy_jobs, so it resumes after a restart. A no-op while it runs anywhere.
   */
  async rankAllPolicies(runId: number): Promise<PolicyJob> {
    const current = await this.policyJob(runId);
    const running = this.policyJobs.has(runId) || (await this.leases.isHeld(`policy:${runId}`));
    if (current !== null && current.status === "running" && running) return current;
    this.assertCapacity();
    const row = await q.startPolicyJob(this.db, runId);
    void this.runPolicyJob(runId);
    return { status: row.status, done: row.done, current: row.current, error: row.error };
  }

  /** Run (or resume) the policy job of an audit in the background; resolves when it ends. */
  runPolicyJob(runId: number): Promise<void> {
    let p = this.policyJobs.get(runId);
    if (p === undefined) {
      p = this.leased(`policy:${runId}`, () => this.policyLoop(runId)).finally(() =>
        this.policyJobs.delete(runId),
      );
      this.policyJobs.set(runId, p);
    }
    return p;
  }

  private async policyLoop(runId: number): Promise<void> {
    const done: string[] = [];
    try {
      for (const policy of Object.keys(canonicalise.POLICIES) as canonicalise.PolicyId[]) {
        const ctx = await this.ctxFor(runId, policy);
        const sigma = ctx.options.sigma ?? ctx.config.sigmaVariant;
        const have = await q.listArtefacts(this.db, runId, {
          kind: fixes.FIX_RANKING_ARTEFACT,
          policyVersion: ctx.policyVersion,
        });
        if (!have.some((r) => (r.payload as { sigmaVariant?: string }).sigmaVariant === sigma)) {
          await q.updatePolicyJob(this.db, runId, { status: "running", done, current: policy });
          for (const stage of RANKING_STAGES) {
            const started = performance.now();
            await this.execute(stage, ctx);
            this.logger.info(
              `[audit ${runId}] ${policy} ${stage} completed in ${(performance.now() - started).toFixed(0)} ms`,
            );
          }
        }
        done.push(policy);
        await q.updatePolicyJob(this.db, runId, { status: "running", done, current: null });
      }
      await q.updatePolicyJob(this.db, runId, { status: "completed", done, current: null });
    } catch (e) {
      const error = errorText(e);
      this.logger.error(`[audit ${runId}] policy ranking failed: ${error}`);
      await q
        .updatePolicyJob(this.db, runId, { status: "failed", done, current: null, error })
        .catch(() => undefined);
    }
  }

  private async ctxFor(runId: number, policy: canonicalise.PolicyId): Promise<Ctx> {
    const audit = await q.getAudit(this.db, runId);
    const run = await q.getRun(this.db, runId);
    if (audit === null || run === null) throw new Error(`audit ${runId} not found`);
    return {
      runId,
      policy,
      policyVersion: canonicalise.POLICIES[policy].version,
      options: audit.options as AuditOptions,
      config: makeConfig(run.config),
    };
  }

  /** Listen to pipeline events (of every instance); returns the unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    return this.bus.subscribe(listener);
  }

  /** Resolves once subscriptions receive events. */
  eventsReady(): Promise<void> {
    return this.bus.ready();
  }

  /**
   * Stop in-process work and disconnect. Crawls stay resumable and the leases are given back,
   * so another instance (or this one, restarted) resumes the audits.
   */
  async close(): Promise<void> {
    await this.orchestrator.shutdown();
    await this.stagePool?.close();
    await this.leases.close();
    await this.bus.close();
  }

  private emitEvent(e: PipelineEvent): void {
    this.bus.publish(e);
  }

  private async run(runId: number): Promise<void> {
    const audit = await q.getAudit(this.db, runId);
    if (audit === null) throw new Error(`audit ${runId} not found`);
    const ctx = await this.ctxFor(runId, audit.policy as canonicalise.PolicyId);
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
      const detail = await this.execute(stage, ctx);
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

  /** Run one stage: a database-only stage (stages.ts) in a stage worker when there are any. */
  private execute(stage: Stage, ctx: Ctx): Promise<q.Json> {
    if (isDbStage(stage)) {
      return this.stagePool === null
        ? dbStages[stage](this.db, ctx)
        : this.stagePool.run(stage, ctx);
    }
    return this.ownStages[stage](ctx);
  }

  /** The stages that need more than the database. */
  private readonly ownStages: Record<Exclude<Stage, DbStage>, StageFn> = {
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

    discovery: async (ctx) => {
      const runner = new DiscoveryRunner(this.shared());
      try {
        const s = await runner.run(ctx.runId);
        return { fetches: s.fetches, capReached: s.capReached, observations: s.observations };
      } finally {
        await runner.close();
      }
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
