import { db as q, type LinkLensConfig } from "@linklens/core";
import type { Throttle } from "./redis-throttle.js";
import { applyUnreachableGrace, fetchRobots, type RobotsPolicy } from "./robots/index.js";
import type { Clock } from "./throttle.js";

interface Cached {
  readonly policy: Promise<RobotsPolicy>;
  readonly fetchedAt: number;
}

/**
 * robots.txt for one run, shared by the crawl and the discovery channels.
 * - Fetched once per origin through the per-host throttle and stored as a `robots` fetch.
 * - Cached for at most config.robotsCacheTtlMs (RFC 9309 §2.4). A failed load is not cached.
 * - Unreachable for robotsUnreachableGraceDays (from earlier runs) → allow all (§2.3.1.4).
 * - Its Crawl-delay feeds the throttle.
 * - Its Sitemap: lines are recorded as robots_sitemap discovery observations with
 *   detail.kind = "directive" (they name sitemap files, not pages).
 */
export class RobotsStore {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly db: q.Queryable,
    private readonly runId: number,
    private readonly config: Readonly<LinkLensConfig>,
    private readonly throttle: Throttle & { dispatched(url: string | URL): Promise<void> | void },
    private readonly fetchImpl: typeof fetch,
    private readonly clock: Clock,
  ) {}

  policyFor(url: URL): Promise<RobotsPolicy> {
    const now = this.clock.now();
    const cached = this.cache.get(url.origin);
    if (cached !== undefined && now - cached.fetchedAt < this.config.robotsCacheTtlMs) {
      return cached.policy;
    }
    const policy = this.load(url);
    this.cache.set(url.origin, { policy, fetchedAt: now });
    policy.catch(() => {
      if (this.cache.get(url.origin)?.policy === policy) this.cache.delete(url.origin);
    });
    return policy;
  }

  private async load(url: URL): Promise<RobotsPolicy> {
    const robotsUrl = new URL("/robots.txt", url);
    await this.throttle.acquire(robotsUrl);
    // fetchRobots issues its first request synchronously; mark the dispatch once it is out.
    const pending = fetchRobots(url, { config: this.config, fetch: this.fetchImpl });
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
      purpose: "robots",
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
          detail: { kind: "directive", line: s.line },
        })),
      );
    }
    return policy;
  }
}
