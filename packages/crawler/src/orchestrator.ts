import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type pg from "pg";
import { db as q, makeConfig, type LinkLensConfig } from "@linklens/core";
import { asQueryable } from "@linklens/db";
import { extractPage } from "./extract.js";
import { fetchPage, type FetchOutcomeKind } from "./fetcher.js";
import { Frontier } from "./frontier.js";
import { RedisHostThrottle } from "./redis-throttle.js";
import { applyUnreachableGrace, fetchRobots, type RobotsPolicy } from "./robots/index.js";
import { stripFragment } from "./html/resolve.js";
import { isHttpUrl, makeScope, requestKey, resolveHref } from "./scope.js";
import { systemClock, type Clock } from "./throttle.js";
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
  /** URLs whose processing has finished (success or final failure), across worker restarts. */
  readonly pagesFetched: number;
  /** Jobs still waiting (including delayed retries). */
  readonly queueSize: number;
  /** URLs admitted to the frontier so far (≤ pageCap). */
  readonly admitted: number;
  readonly url: string;
  readonly depth: number;
  readonly outcome: FetchOutcomeKind | "failed";
  readonly statusCode: number | null;
}

export interface CrawlSummary {
  readonly runId: number;
  /** "detached": this process stopped working on the run; it is still running and resumable. */
  readonly status: "completed" | "cancelled" | "failed" | "detached";
  readonly pagesFetched: number;
  readonly admitted: number;
  readonly error?: string;
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

/** @internal exported for unit tests */
export function jobOptions(config: Readonly<LinkLensConfig>, depth: number): JobsOptions {
  return {
    // Lower number = processed first; FIFO within a priority, so the queue is BFS by depth.
    priority: Math.min(depth + 1, MAX_PRIORITY),
    attempts: config.fetchMaxRetries + 1,
    backoff: { type: "exponential", delay: config.retryBackoffMs },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/** @internal exported for unit tests: may a discovered link be enqueued under the nofollow setting? */
export function mayFollow(
  config: Readonly<Pick<LinkLensConfig, "followNofollow">>,
  pageNofollow: boolean,
  rel: string | null,
): boolean {
  if (config.followNofollow) return true;
  if (pageNofollow) return false;
  return !(rel ?? "").toLowerCase().split(/\s+/).includes("nofollow");
}

/**
 * Creates runs and drives their crawls through a BullMQ queue per run.
 *
 * Invariants:
 *  - robots.txt is checked before every request, including every redirect hop;
 *  - every request waits on the per-host throttle (shared through Redis by all workers);
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
  async releaseQueue(runId: number, obliterate: boolean): Promise<void> {
    const queue = this.queues.get(runId);
    if (queue === undefined) return;
    if (obliterate) await queue.obliterate({ force: true });
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

  /** Start a worker for a pending run. Resolves once the worker is running. */
  async start(runId: number): Promise<CrawlHandle> {
    return this.launch(runId, "pending");
  }

  /**
   * Continue a run left in "running" by a stopped or crashed process: its queue and frontier live
   * in Redis, so the crawl picks up where it was. Jobs that were in flight in a crashed process are
   * re-queued by BullMQ's stalled-job check (after its lock expires) and fetched again.
   * If the Redis state is gone, the run is marked failed.
   */
  async resume(runId: number): Promise<CrawlHandle> {
    return this.launch(runId, "running");
  }

  private async launch(runId: number, expected: "pending" | "running"): Promise<CrawlHandle> {
    if (this.handles.has(runId)) throw new Error(`run ${runId} is already running here`);
    const run = await q.getRun(this.db, runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    if (run.status !== expected) {
      throw new Error(`run ${runId} is ${run.status}, expected ${expected}`);
    }
    const site = await q.getSite(this.db, run.siteId);
    if (site === null) throw new Error(`site ${run.siteId} not found`);
    const config = makeConfig(run.config);

    const handle = new CrawlHandle(this, this.db, this.redis, {
      runId,
      config,
      seed: new URL(site.rootUrl),
      fetch: this.options.fetch ?? fetch,
      clock: this.options.clock ?? systemClock,
      prefix: this.prefix,
    });
    this.handles.set(runId, handle);
    void handle.done.finally(() => this.handles.delete(runId));

    if (expected === "running" && !(await this.frontierFor(runId, config.pageCap).exists())) {
      await handle.fail("frontier state missing in Redis; the run cannot be resumed");
      return handle;
    }
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

  /** Stop working on runs without cancelling them (they stay resumable), then disconnect. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.handles.values()].map((h) => h.detach()));
    await this.disconnect();
  }

  /** Cancel running crawls and close all connections. */
  async close(): Promise<void> {
    await Promise.all([...this.handles.values()].map((h) => h.cancel()));
    await this.disconnect();
  }

  private async disconnect(): Promise<void> {
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

interface CachedRobots {
  readonly policy: Promise<RobotsPolicy>;
  readonly fetchedAt: number;
}

/** A running crawl. Emits `progress` after every finished URL, `done` once, `error` on faults. */
export class CrawlHandle extends EventEmitter<HandleEvents> {
  readonly runId: number;
  readonly done: Promise<CrawlSummary>;

  private resolveDone!: (s: CrawlSummary) => void;
  private readonly config: Readonly<LinkLensConfig>;
  private readonly frontier: Frontier;
  private readonly queue: Queue<CrawlJobData>;
  private readonly throttle: RedisHostThrottle;
  private readonly inScope: (url: URL) => boolean;
  private readonly robotsCache = new Map<string, CachedRobots>();
  private readonly abort = new AbortController();
  private worker: Worker<CrawlJobData, CrawlJobResult> | null = null;
  private stopping = false;
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
    this.throttle = new RedisHostThrottle(redis, settings.prefix, settings.config, settings.clock);
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

  /** Stop, discard the remaining queue, and mark the run cancelled. */
  async cancel(): Promise<CrawlSummary> {
    if (this.finished || this.stopping) return this.done;
    this.stopping = true;
    await this.frontier.requestCancel();
    this.abort.abort();
    await this.worker?.close(); // waits for the in-flight job, which sees the abort
    await this.finish("cancelled");
    return this.done;
  }

  /**
   * Stop this process's worker after its in-flight job, keeping the queue and frontier in Redis.
   * The run stays "running" and can be continued with `CrawlOrchestrator.resume()`.
   */
  async detach(): Promise<CrawlSummary> {
    if (this.finished || this.stopping) return this.done;
    this.stopping = true;
    await this.worker?.close();
    this.finished = true;
    await this.orchestrator.releaseQueue(this.runId, false);
    this.settle({ status: "detached" });
    return this.done;
  }

  /** @internal Mark the run failed without starting a worker. */
  async fail(error: string): Promise<void> {
    this.finished = true;
    await q.setRunStatus(this.db, this.runId, "failed");
    await this.orchestrator.releaseQueue(this.runId, true);
    this.settle({ status: "failed", error });
  }

  private settle(s: { status: CrawlSummary["status"]; error?: string }): void {
    void (async () => {
      const summary: CrawlSummary = {
        runId: this.runId,
        status: s.status,
        pagesFetched: await this.frontier.finishedCount(),
        admitted: await this.frontier.admittedCount(),
        ...(s.error === undefined ? {} : { error: s.error }),
      };
      if (s.status !== "detached") await this.frontier.clear();
      this.emit("done", summary);
      this.resolveDone(summary);
    })().catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.resolveDone({ runId: this.runId, status: s.status, pagesFetched: 0, admitted: 0 });
    });
  }

  private onFinished(
    url: string,
    depth: number,
    outcome: FetchOutcomeKind | "failed",
    statusCode: number | null,
  ): void {
    if (outcome === "cancelled" || this.finished) return;
    void (async () => {
      try {
        const pagesFetched = await this.frontier.incrFinished();
        const counts = await this.queue.getJobCounts(...QUEUE_STATES);
        const queueSize =
          (counts["waiting"] ?? 0) + (counts["prioritized"] ?? 0) + (counts["delayed"] ?? 0);
        this.emit("progress", {
          runId: this.runId,
          pagesFetched,
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
    if (this.finished || this.stopping) return;
    const counts = await this.queue.getJobCounts(...QUEUE_STATES);
    const remaining = QUEUE_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
    if (remaining === 0) await this.finish("completed");
  }

  private async finish(status: "completed" | "cancelled"): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    try {
      await this.worker?.close();
      await this.orchestrator.releaseQueue(this.runId, true);
      await q.setRunStatus(this.db, this.runId, status);
      this.settle({ status });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
      this.settle({ status: "failed", error: error.message });
    }
  }

  /**
   * robots.txt for the URL's origin, stored as a fetch. Cached per origin for at most
   * config.robotsCacheTtlMs (RFC 9309 §2.4). A failed lookup is not cached, so the next request
   * retries it instead of inheriting the failure.
   */
  private robotsFor(url: URL): Promise<RobotsPolicy> {
    const now = this.settings.clock.now();
    const cached = this.robotsCache.get(url.origin);
    if (cached !== undefined && now - cached.fetchedAt < this.config.robotsCacheTtlMs) {
      return cached.policy;
    }
    const policy = this.loadRobots(url);
    this.robotsCache.set(url.origin, { policy, fetchedAt: now });
    policy.catch(() => {
      if (this.robotsCache.get(url.origin)?.policy === policy) this.robotsCache.delete(url.origin);
    });
    return policy;
  }

  private async loadRobots(url: URL): Promise<RobotsPolicy> {
    const robotsUrl = new URL("/robots.txt", url);
    await this.throttle.acquire(robotsUrl);
    // fetchRobots issues its first request synchronously; mark the dispatch once it is out.
    const pending = fetchRobots(url, { config: this.config, fetch: this.settings.fetch });
    await this.throttle.dispatched(robotsUrl);
    const { policy: fetched, record } = await pending;
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
        (fetched.source.kind === "parsed"
          ? null
          : `robots.txt ${fetched.source.kind}: ${fetched.source.detail}`),
    });

    let policy = fetched;
    if (fetched.source.kind === "unreachable") {
      const history = await q.listFetchHistory(this.db, record.requestedUrl, 1000);
      policy = applyUnreachableGrace(
        fetched,
        history,
        record.fetchedAt,
        this.config.robotsUnreachableGraceDays,
        this.config.robotsTreat429AsUnreachable,
      );
    }

    await this.throttle.setRobotsCrawlDelay(url, policy.crawlDelayMs);
    if (policy.sitemaps.length > 0) {
      await q.insertDiscoveryObservations(
        this.db,
        policy.sitemaps.map((s) => ({
          runId: this.runId,
          channel: "robots_sitemap" as const,
          url: s.url,
          sourceDocument: record.finalUrl ?? record.requestedUrl,
        })),
      );
    }
    return policy;
  }

  private async process(job: Job<CrawlJobData, CrawlJobResult>): Promise<CrawlJobResult> {
    const { url, depth } = job.data;
    const cancelled: CrawlJobResult = { url, depth, outcome: "cancelled", statusCode: null };
    if (this.stopping || (await this.frontier.isCancelled())) return cancelled;

    const o = await fetchPage(
      new URL(url),
      {
        config: this.config,
        fetch: this.settings.fetch,
        throttle: this.throttle,
        robots: (u) => this.robotsFor(u),
        inScope: this.inScope,
        signal: this.abort.signal,
      },
      url, // stored as requested_url exactly as it was discovered
    );
    if (o.kind === "cancelled") return cancelled;

    const attempt = job.attemptsMade + 1;
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
      attempt,
    });
    if (o.rawBody !== null && this.config.storeRawHtml) {
      await q.insertFetchBody(this.db, {
        fetchId: fetchRow.id,
        runId: this.runId,
        body: Buffer.from(o.rawBody.buffer, o.rawBody.byteOffset, o.rawBody.byteLength),
        truncated: o.truncated,
        sha256: createHash("sha256").update(o.rawBody).digest("hex"),
      });
    }

    if (o.retryable && attempt < (job.opts.attempts ?? 1)) {
      throw new RetryableFetchError(o.error ?? `HTTP ${o.statusCode ?? "?"}`);
    }

    if (o.finalUrl !== null && o.statusCode !== null && o.statusCode < 300) {
      const finalKey = requestKey(new URL(o.finalUrl));
      // A redirect target already in the frontier is (or will be) processed by its own job.
      const firstVisit = finalKey === url || (await this.frontier.markSeen(finalKey));
      if (firstVisit && o.html !== null) {
        await this.processHtml(o.html, o.finalUrl, fetchRow.id, depth);
      }
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
      nofollow: page.nofollow,
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
        templateSignature: l.templateSignature,
        positionIndex: l.positionIndex,
      })),
    );

    const children: { name: string; data: CrawlJobData; opts: JobsOptions }[] = [];
    for (const link of page.links) {
      if (!mayFollow(this.config, page.nofollow, link.rel)) continue;
      // The frontier key is the RFC 3986-resolved string minus its fragment; WHATWG parsing is
      // used only to test scope and to send the request. Unparsable links are recorded, not fetched.
      const target = resolveHref(link.resolvedUrl, pageUrl);
      if (target === null || !this.inScope(target)) continue;
      const key = stripFragment(link.resolvedUrl);
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
