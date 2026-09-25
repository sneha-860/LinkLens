import { EventEmitter } from "node:events";
import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type pg from "pg";
import { db as q, makeConfig, type LinkLensConfig } from "@linklens/core";
import { asQueryable } from "@linklens/db";
import { extractPage } from "./extract.js";
import { fetchPage, type FetchOutcomeKind } from "./fetcher.js";
import { Frontier } from "./frontier.js";
import { fetchRobots, type RobotsPolicy } from "./robots/index.js";
import { isHttpUrl, makeScope, requestKey } from "./scope.js";
import { HostThrottle, systemClock, type Clock } from "./throttle.js";
import { checkUserAgent } from "./user-agent.js";

export interface CrawlJobData {
  /** Request key (resolved URL string without fragment). */
  readonly url: string;
  /** BFS depth from the seed (seed = 0). */
  readonly depth: number;
}

interface CrawlJobResult {
  readonly url: string;
  readonly depth: number;
  readonly outcome: FetchOutcomeKind;
  readonly statusCode: number | null;
}

export interface CrawlProgress {
  readonly runId: number;
  /** URLs whose processing has finished (success or final failure). */
  readonly pagesFetched: number;
  /** Jobs still waiting (including delayed retries). */
  readonly queueSize: number;
  /** URLs admitted to the frontier so far (â‰¤ pageCap). */
  readonly admitted: number;
  readonly url: string;
  readonly depth: number;
  readonly outcome: FetchOutcomeKind | "failed";
  readonly statusCode: number | null;
}

export interface CrawlSummary {
  readonly runId: number;
  readonly status: "completed" | "cancelled" | "failed";
  readonly pagesFetched: number;
  readonly admitted: number;
}

export interface CreateRunOptions {
  /** Overrides on top of the defaults; the full effective config is stored on the run. */
  readonly config?: Partial<LinkLensConfig>;
  readonly architectureClass?: string | null;
}

export interface CreatedRun {
  readonly runId: number;
  readonly siteId: number;
  readonly seedUrl: string;
}

export interface OrchestratorOptions {
  readonly pool: pg.Pool;
  readonly redisUrl: string;
  /** Prefix for BullMQ queues and frontier keys (tests use a unique one). */
  readonly prefix?: string;
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
}

const MAX_PRIORITY = 2_097_151;
const QUEUE_STATES = ["waiting", "prioritized", "delayed", "active"] as const;

class RetryableFetchError extends Error {
  override readonly name = "RetryableFetchError";
}

function jobOptions(config: Readonly<LinkLensConfig>, depth: number): JobsOptions {
  return {
    // Lower number = processed first; FIFO within a priority, so the queue is BFS by depth.
    priority: Math.min(depth + 1, MAX_PRIORITY),
    attempts: config.fetchMaxRetries + 1,
    backoff: { type: "exponential", delay: config.retryBackoffMs },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/**
 * Creates runs and drives their crawls through a BullMQ queue per run.
 *
 * Invariants:
 *  - robots.txt is checked before every request, including every redirect hop;
 *  - every request waits on the per-host token bucket;
 *  - every attempt (including retries and robots.txt fetches) is appended to `fetches`;
 *  - dedupe is on the resolved URL string (minus fragment) only; no canonicalisation.
 */
export class CrawlOrchestrator {
  private readonly db: q.Queryable;
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly queues = new Map<number, Queue<CrawlJobData>>();
  private readonly handles = new Map<number, CrawlHandle>();

  constructor(private readonly options: OrchestratorOptions) {
    this.db = asQueryable(options.pool);
    this.redis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    this.prefix = options.prefix ?? "linklens";
  }

  queueName(runId: number): string {
    return `crawl-run-${runId}`;
  }

  /** @internal */
  queueFor(runId: number): Queue<CrawlJobData> {
    let queue = this.queues.get(runId);
    if (queue === undefined) {
      queue = new Queue<CrawlJobData>(this.queueName(runId), {
        connection: this.redis,
        prefix: this.prefix,
      });
      this.queues.set(runId, queue);
    }
    return queue;
  }

  /** @internal */
  frontierFor(runId: number, pageCap: number): Frontier {
    return new Frontier(this.redis, `${this.prefix}:run:${runId}`, pageCap);
  }

  /** @internal */
  async releaseQueue(runId: number): Promise<void> {
    const queue = this.queues.get(runId);
    if (queue === undefined) return;
    await queue.obliterate({ force: true });
    await queue.close();
    this.queues.delete(runId);
  }

  /** Insert a run for `siteRoot` (kept raw in sites.root_url) and enqueue the seed. */
  async createRun(siteRoot: string, options: CreateRunOptions = {}): Promise<CreatedRun> {
    const seed = new URL(siteRoot);
    if (!isHttpUrl(seed)) throw new Error(`site root must be http(s): ${siteRoot}`);
    const config = makeConfig(options.config);
    const uaProblems = checkUserAgent(config.userAgent);
    if (uaProblems.length > 0) {
      throw new Error(`config.userAgent is not identifying: ${uaProblems.join("; ")}`);
    }

    const site =
      (await q.getSiteByRootUrl(this.db, siteRoot)) ??
      (await q.insertSite(this.db, {
        rootUrl: siteRoot,
        architectureClass: options.architectureClass ?? null,
      }));
    const run = await q.createRun(this.db, { siteId: site.id, config });

    const seedUrl = requestKey(seed);
    await this.frontierFor(run.id, config.pageCap).admit(seedUrl);
    await this.queueFor(run.id).add("fetch", { url: seedUrl, depth: 0 }, jobOptions(config, 0));
    return { runId: run.id, siteId: site.id, seedUrl };
  }

  /** Start a worker for the run. Resolves once the worker is running. */
  async start(runId: number): Promise<CrawlHandle> {
    if (this.handles.has(runId)) throw new Error(`run ${runId} is already running here`);
    const run = await q.getRun(this.db, runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    if (run.status !== "pending")
      throw new Error(`run ${runId} is ${run.status}, expected pending`);
    const site = await q.getSite(this.db, run.siteId);
    if (site === null) throw new Error(`site ${run.siteId} not found`);

    const handle = new CrawlHandle(this, this.db, this.redis, {
      runId,
      config: makeConfig(run.config),
      seed: new URL(site.rootUrl),
      fetch: this.options.fetch ?? fetch,
      clock: this.options.clock ?? systemClock,
      prefix: this.prefix,
    });
    this.handles.set(runId, handle);
    void handle.done.finally(() => this.handles.delete(runId));
    await handle.begin();
    return handle;
  }

  /** Convenience: create a run, crawl it to the end, and return the summary. */
  async crawl(siteRoot: string, options: CreateRunOptions = {}): Promise<CrawlSummary> {
    const { runId } = await this.createRun(siteRoot, options);
    const handle = await this.start(runId);
    return handle.done;
  }

  /** Cancel a run running in this process. */
  async cancel(runId: number): Promise<CrawlSummary> {
    const handle = this.handles.get(runId);
    if (handle === undefined) throw new Error(`run ${runId} is not running here`);
    return handle.cancel();
  }

  /** Cancel running crawls and close all connections. */
  async close(): Promise<void> {
    await Promise.all([...this.handles.values()].map((h) => h.cancel()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
    await this.redis.quit();
  }
}

interface HandleSettings {
  readonly runId: number;
  readonly config: Readonly<LinkLensConfig>;
  readonly seed: URL;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly prefix: string;
}

interface HandleEvents {
  progress: [CrawlProgress];
  done: [CrawlSummary];
  error: [Error];
}

/** A running crawl. Emits `progress` after every finished URL, `done` once, `error` on faults. */
export class CrawlHandle extends EventEmitter<HandleEvents> {
  readonly runId: number;
  readonly done: Promise<CrawlSummary>;

  private resolveDone!: (s: CrawlSummary) => void;
  private readonly config: Readonly<LinkLensConfig>;
  private readonly frontier: Frontier;
  private readonly queue: Queue<CrawlJobData>;
  private readonly throttle: HostThrottle;
  private readonly inScope: (url: URL) => boolean;
  private readonly robotsCache = new Map<string, Promise<RobotsPolicy>>();
  private readonly abort = new AbortController();
  private worker: Worker<CrawlJobData, CrawlJobResult> | null = null;
  private pagesFetched = 0;
  private cancelling = false;
  private finished = false;

  constructor(
    private readonly orchestrator: CrawlOrchestrator,
    private readonly db: q.Queryable,
    private readonly redis: Redis,
    private readonly settings: HandleSettings,
  ) {
    super();
    this.runId = settings.runId;
    this.config = settings.config;
    this.frontier = orchestrator.frontierFor(settings.runId, settings.config.pageCap);
    this.queue = orchestrator.queueFor(settings.runId);
    this.throttle = new HostThrottle(settings.config, settings.clock);
    this.inScope = makeScope(settings.seed, settings.config.includeSubdomains);
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  /** @internal */
  async begin(): Promise<void> {
    await q.setRunStatus(this.db, this.runId, "running");
    const worker = new Worker<CrawlJobData, CrawlJobResult>(
      this.orchestrator.queueName(this.runId),
      (job) => this.process(job),
      {
        connection: this.redis,
        prefix: this.settings.prefix,
        concurrency: this.config.crawlConcurrency,
        autorun: false,
      },
    );
    this.worker = worker;

    worker.on("completed", (_job, result) => {
      this.onFinished(result.url, result.depth, result.outcome, result.statusCode);
    });
    worker.on("failed", (job, err) => {
      if (job === undefined) return;
      if (err instanceof RetryableFetchError || err.name === "RetryableFetchError") return; // retry scheduled
      if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // BullMQ will retry
      this.emit("error", err);
      this.onFinished(job.data.url, job.data.depth, "failed", null);
    });
    worker.on("error", (err) => this.emit("error", err));

    void worker.run();
    await worker.waitUntilReady();
    void this.checkDone();
  }

  async cancel(): Promise<CrawlSummary> {
    if (this.finished || this.cancelling) return this.done;
    this.cancelling = true;
    await this.frontier.requestCancel();
    this.abort.abort();
    await this.worker?.close(); // waits for the in-flight job, which sees the abort
    await this.finish("cancelled");
    return this.done;
  }

  private onFinished(
    url: string,
    depth: number,
    outcome: FetchOutcomeKind | "failed",
    statusCode: number | null,
  ): void {
    if (outcome === "cancelled" || this.finished) return;
    this.pagesFetched += 1;
    void (async () => {
      try {
        const counts = await this.queue.getJobCounts(...QUEUE_STATES);
        const queueSize =
          (counts["waiting"] ?? 0) + (counts["prioritized"] ?? 0) + (counts["delayed"] ?? 0);
        this.emit("progress", {
          runId: this.runId,
          pagesFetched: this.pagesFetched,
          queueSize,
          admitted: await this.frontier.admittedCount(),
          url,
          depth,
          outcome,
          statusCode,
        });
        await this.checkDone();
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  private async checkDone(): Promise<void> {
    if (this.finished || this.cancelling) return;
    const counts = await this.queue.getJobCounts(...QUEUE_STATES);
    const remaining = QUEUE_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
    if (remaining === 0) await this.finish("completed");
  }

  private async finish(status: CrawlSummary["status"]): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    try {
      await this.worker?.close();
      await this.orchestrator.releaseQueue(this.runId);
      await q.setRunStatus(this.db, this.runId, status);
      const summary: CrawlSummary = {
        runId: this.runId,
        status,
        pagesFetched: this.pagesFetched,
        admitted: await this.frontier.admittedCount(),
      };
      await this.frontier.clear();
      this.emit("done", summary);
      this.resolveDone(summary);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
      this.resolveDone({
        runId: this.runId,
        status: "failed",
        pagesFetched: this.pagesFetched,
        admitted: 0,
      });
    }
  }

  /** robots.txt for the URL's origin; fetched once per origin per run and stored as a fetch. */
  private robotsFor(url: URL): Promise<RobotsPolicy> {
    let policy = this.robotsCache.get(url.origin);
    if (policy === undefined) {
      policy = (async () => {
        await this.throttle.acquire(new URL("/robots.txt", url));
        const { policy: p, record } = await fetchRobots(url, {
          config: this.config,
          fetch: this.settings.fetch,
        });
        await q.insertFetch(this.db, {
          runId: this.runId,
          requestedUrl: record.requestedUrl,
          finalUrl: record.finalUrl,
          statusCode: record.statusCode,
          redirectChain: [...record.redirectChain],
          headers: {},
          contentType: null,
          fetchedAt: record.fetchedAt,
          bytes: null,
          error:
            record.error ??
            (p.source.kind === "parsed" ? null : `robots.txt ${p.source.kind}: ${p.source.detail}`),
        });
        this.throttle.setRobotsCrawlDelay(url, p.crawlDelayMs);
        if (p.sitemaps.length > 0) {
          await q.insertDiscoveryObservations(
            this.db,
            p.sitemaps.map((s) => ({
              runId: this.runId,
              channel: "robots_sitemap" as const,
              url: s.url,
              sourceDocument: record.finalUrl ?? record.requestedUrl,
            })),
          );
        }
        return p;
      })();
      this.robotsCache.set(url.origin, policy);
    }
    return policy;
  }

  private async process(job: Job<CrawlJobData, CrawlJobResult>): Promise<CrawlJobResult> {
    const { url, depth } = job.data;
    const cancelled: CrawlJobResult = { url, depth, outcome: "cancelled", statusCode: null };
    if (this.cancelling || (await this.frontier.isCancelled())) return cancelled;

    const o = await fetchPage(new URL(url), {
      config: this.config,
      fetch: this.settings.fetch,
      throttle: this.throttle,
      robots: (u) => this.robotsFor(u),
      inScope: this.inScope,
      signal: this.abort.signal,
    });
    if (o.kind === "cancelled") return cancelled;

    const fetchRow = await q.insertFetch(this.db, {
      runId: this.runId,
      requestedUrl: o.requestedUrl,
      finalUrl: o.finalUrl,
      statusCode: o.statusCode,
      redirectChain: o.redirectChain,
      headers: o.headers,
      contentType: o.contentType,
      bytes: o.bytes,
      error: o.error,
    });

    const attempt = job.attemptsMade + 1;
    if (o.retryable && attempt < (job.opts.attempts ?? 1)) {
      throw new RetryableFetchError(o.error ?? `HTTP ${o.statusCode ?? "?"}`);
    }

    if (o.finalUrl !== null && o.statusCode !== null && o.statusCode < 300) {
      const finalKey = requestKey(new URL(o.finalUrl));
      // A redirect target already in the frontier is (or will be) processed by its own job.
      const firstVisit = finalKey === url || (await this.frontier.markSeen(finalKey));
      if (firstVisit && o.html !== null)
        await this.processHtml(o.html, o.finalUrl, fetchRow.id, depth);
    }
    return { url, depth, outcome: o.kind, statusCode: o.statusCode };
  }

  private async processHtml(
    html: string,
    pageUrl: string,
    fetchId: number,
    depth: number,
  ): Promise<void> {
    const page = extractPage(html, pageUrl);
    await q.insertPage(this.db, {
      runId: this.runId,
      fetchId,
      url: pageUrl,
      title: page.title,
      h1: page.h1,
      headings: page.headings,
      metaCanonical: page.metaCanonical,
      metaRobots: page.metaRobots,
      bodyText: page.bodyText,
      paragraphs: page.paragraphs,
      lang: page.lang,
    });
    await q.insertLinkObservations(
      this.db,
      page.links.map((l) => ({
        runId: this.runId,
        sourceFetchId: fetchId,
        rawHref: l.rawHref,
        resolvedUrl: l.resolvedUrl,
        anchorText: l.anchorText,
        rel: l.rel,
        domRegion: l.domRegion,
        domPath: l.domPath,
        templateSignature: null,
        positionIndex: l.positionIndex,
      })),
    );

    const children: { name: string; data: CrawlJobData; opts: JobsOptions }[] = [];
    for (const link of page.links) {
      if (link.resolvedUrl === null) continue;
      const target = new URL(link.resolvedUrl);
      if (!this.inScope(target)) continue;
      const key = requestKey(target);
      if ((await this.frontier.admit(key)) === "admitted") {
        children.push({
          name: "fetch",
          data: { url: key, depth: depth + 1 },
          opts: jobOptions(this.config, depth + 1),
        });
      }
    }
    if (children.length > 0) await this.queue.addBulk(children);
  }
}
