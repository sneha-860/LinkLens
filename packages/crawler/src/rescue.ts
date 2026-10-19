import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type pg from "pg";
import { db as q, discovery, type canonicalise, type LinkLensConfig } from "@linklens/core";
import { asQueryable } from "@linklens/db";
import { extractPage } from "./extract.js";
import { fetchPage } from "./fetcher.js";
import { RedisHostThrottle } from "./redis-throttle.js";
import { RobotsStore } from "./robots-store.js";
import { followUpConfig } from "./run-config.js";
import { makeScope } from "./scope.js";
import { systemClock, type Clock } from "./throttle.js";

export interface RescueFetchOptions {
  readonly pool: pg.Pool;
  readonly redisUrl: string;
  /** Must match the crawl's prefix so the per-host throttle is shared. */
  readonly prefix?: string;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  /** Overrides on top of the run's stored config (e.g. a smaller rescueMaxFetches). */
  readonly config?: Partial<LinkLensConfig>;
}

export interface RescueFetchSummary {
  readonly runId: number;
  readonly orphans: number;
  /** Requests made (their own cap: config.rescueMaxFetches). */
  readonly fetches: number;
  /** Orphan pages stored (2xx HTML). */
  readonly pages: number;
  /** Orphans already fetched for this run (by a crawl or an earlier rescue): not requested. */
  readonly alreadyFetched: number;
  readonly capReached: boolean;
}

export type RescueStep =
  | { readonly kind: "already-fetched" }
  | { readonly kind: "no-url" }
  | { readonly kind: "invalid" | "out-of-scope"; readonly raw: string; readonly error: string }
  | { readonly kind: "fetch"; readonly raw: string; readonly url: URL };

/**
 * Pure: what rescue does with one orphan, before any request. An orphan already fetched (by the
 * crawl or an earlier rescue) is skipped; otherwise its first raw URL is fetched, unless it does
 * not parse or is outside the crawl scope (recorded, never requested). Reconciled orphans are
 * internal, but scope is checked again here because fetchPage checks it on redirect hops only.
 */
export function rescueStep(
  urls: readonly string[],
  done: ReadonlySet<string>,
  inScope: (url: URL) => boolean,
): RescueStep {
  if (urls.some((u) => done.has(u))) return { kind: "already-fetched" };
  const raw = urls[0];
  if (raw === undefined) return { kind: "no-url" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid", raw, error: "rescue: not a valid URL, not fetched" };
  }
  if (!inScope(url)) {
    return { kind: "out-of-scope", raw, error: "rescue: outside the crawl scope, not fetched" };
  }
  return { kind: "fetch", raw, url };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Fetches each reconciled orphan's page (its first raw URL) so its text can be scored for rescue
 * donors. Runs after discovery, with the crawl's prefix so the per-host throttle is shared; every
 * request obeys scope and robots.txt per hop. Fetches are stored with purpose `rescue` and count
 * toward rescueMaxFetches, never pageCap. 2xx HTML is extracted into `pages` (and its bytes into
 * `fetch_bodies` when storeRawHtml is on). Its links are not stored: rescue pages never feed the
 * link graph, which is built from crawl pages only. One attempt per orphan, no retries.
 */
export class RescueFetcher {
  private readonly db: q.Queryable;
  private readonly redis: Redis;

  constructor(private readonly options: RescueFetchOptions) {
    this.db = asQueryable(options.pool);
    this.redis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  async run(runId: number, policyId: canonicalise.PolicyId = "P0"): Promise<RescueFetchSummary> {
    const run = await q.getRun(this.db, runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    const site = await q.getSite(this.db, run.siteId);
    if (site === null) throw new Error(`site ${run.siteId} not found`);
    // Overrides may only make rescue more polite; the User-Agent is checked again.
    const config = followUpConfig(run.config, this.options.config);
    const clock = this.options.clock ?? systemClock;
    const fetchImpl = this.options.fetch ?? fetch;
    const throttle = new RedisHostThrottle(
      this.redis,
      this.options.prefix ?? "linklens",
      config,
      clock,
    );
    const robots = new RobotsStore(this.db, runId, config, throttle, fetchImpl, clock);
    const inScope = makeScope(new URL(site.rootUrl), config.includeSubdomains);

    const rec = await discovery.loadReconciliation(this.db, runId, policyId);
    const orphans = rec.inventory.filter((e) => e.orphan);
    const done = new Set(
      (await q.listFetches(this.db, runId))
        .filter((f) => f.purpose === "crawl" || f.purpose === "rescue")
        .map((f) => f.requestedUrl),
    );

    let fetches = 0;
    let pages = 0;
    let alreadyFetched = 0;
    let capReached = false;
    for (const orphan of orphans) {
      const step = rescueStep(orphan.urls, done, inScope);
      if (step.kind === "already-fetched") {
        alreadyFetched += 1;
        continue;
      }
      if (step.kind === "no-url") continue;
      if (fetches >= config.rescueMaxFetches) {
        capReached = true;
        break;
      }
      if (step.kind !== "fetch") {
        await q.insertFetch(this.db, {
          runId,
          requestedUrl: step.raw,
          purpose: "rescue",
          error: step.error,
        });
        continue;
      }
      const { raw, url } = step;
      fetches += 1;
      const o = await fetchPage(
        url,
        { config, fetch: fetchImpl, throttle, robots: (u) => robots.policyFor(u), inScope },
        raw,
      );
      if (o.kind === "blocked" && o.statusCode === null) fetches -= 1; // nothing was sent
      const row = await q.insertFetch(this.db, {
        runId,
        requestedUrl: o.requestedUrl,
        finalUrl: o.finalUrl,
        statusCode: o.statusCode,
        redirectChain: o.redirectChain,
        headers: o.headers,
        contentType: o.contentType,
        bytes: o.bytes,
        error: o.error,
        purpose: "rescue",
      });
      done.add(raw);
      if (o.html === null || o.finalUrl === null) continue;
      if (config.storeRawHtml && o.rawBody !== null) {
        await q.insertFetchBody(this.db, {
          fetchId: row.id,
          runId,
          body: Buffer.from(o.rawBody.buffer, o.rawBody.byteOffset, o.rawBody.byteLength),
          truncated: o.truncated,
          sha256: sha256(o.rawBody),
        });
      }
      const page = extractPage(o.html, o.finalUrl);
      await q.insertPage(this.db, {
        runId,
        fetchId: row.id,
        url: o.finalUrl,
        title: page.title,
        h1: page.h1,
        headings: page.headings,
        metaCanonical: page.metaCanonical,
        metaRobots: page.metaRobots,
        bodyText: page.bodyText,
        paragraphs: page.paragraphs,
        lang: page.lang,
        nofollow: page.nofollow,
        baseHref: page.baseHref,
      });
      pages += 1;
    }
    return { runId, orphans: orphans.length, fetches, pages, alreadyFetched, capReached };
  }
}
