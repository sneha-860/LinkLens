import type { LinkLensConfig } from "@linklens/core";
import {
  compileRules,
  decide,
  selectGroups,
  type CompiledRule,
  type MatchDecision,
} from "./match.js";
import { decodeRobots, parseRobots, type ParsedRobots, type SitemapDirective } from "./parse.js";
import { requestHeaders } from "../user-agent.js";

/**
 * How robots.txt was obtained, which decides how it is applied (RFC 9309 §2.3.1):
 *  - "parsed": 2xx; the file's rules apply.
 *  - "unavailable": 4xx (or too many redirects); the crawler MAY access any resource → allow all.
 *  - "unreachable": 5xx, network error or timeout; the crawler MUST assume complete disallow.
 */
export type RobotsSource =
  | { readonly kind: "parsed"; readonly robots: ParsedRobots }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "unreachable"; readonly detail: string };

export interface RobotsFetchRecord {
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  readonly statusCode: number | null;
  readonly redirectChain: readonly { url: string; statusCode: number }[];
  readonly fetchedAt: Date;
  readonly error: string | null;
}

/** robots.txt as it applies to one crawler (user agent) on one origin. */
export class RobotsPolicy {
  readonly source: RobotsSource;
  readonly userAgent: string;
  private readonly rules: CompiledRule[];
  private readonly delaySeconds: number | null;

  constructor(source: RobotsSource, userAgent: string) {
    this.source = source;
    this.userAgent = userAgent;
    if (source.kind === "parsed") {
      const groups = selectGroups(source.robots, userAgent);
      this.rules = compileRules(groups);
      const delays = groups.map((g) => g.crawlDelaySeconds).filter((d): d is number => d !== null);
      this.delaySeconds = delays.length > 0 ? Math.max(...delays) : null;
    } else {
      this.rules = [];
      this.delaySeconds = null;
    }
  }

  static fromText(text: string, userAgent: string): RobotsPolicy {
    return new RobotsPolicy({ kind: "parsed", robots: parseRobots(text) }, userAgent);
  }

  check(url: string | URL): MatchDecision {
    const u = typeof url === "string" ? new URL(url) : url;
    if (this.source.kind === "unreachable" && u.pathname !== "/robots.txt") {
      return { allowed: false, rule: null, reason: "robots-unreachable" };
    }
    return decide(this.rules, u);
  }

  isAllowed(url: string | URL): boolean {
    return this.check(url).allowed;
  }

  /** Crawl-delay for our group in ms, or null. Merged groups take the largest value. */
  get crawlDelayMs(): number | null {
    return this.delaySeconds === null ? null : Math.round(this.delaySeconds * 1000);
  }

  /** Sitemap directives (a discovery channel). Global, so independent of the user agent. */
  get sitemaps(): readonly SitemapDirective[] {
    return this.source.kind === "parsed" ? this.source.robots.sitemaps : [];
  }
}

export interface FetchRobotsOptions {
  readonly config: Readonly<LinkLensConfig>;
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export interface FetchRobotsResult {
  readonly policy: RobotsPolicy;
  /** Raw fetch facts for append-only storage (fetches table). */
  readonly record: RobotsFetchRecord;
}

const isRedirect = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

/** Fetch and interpret `<origin>/robots.txt` per RFC 9309 §2.3. Never throws for network errors. */
export async function fetchRobots(
  siteUrl: string | URL,
  { config, fetch: fetchImpl = fetch, now = () => new Date() }: FetchRobotsOptions,
): Promise<FetchRobotsResult> {
  const requestedUrl = new URL("/robots.txt", siteUrl).toString();
  const fetchedAt = now();
  const redirectChain: { url: string; statusCode: number }[] = [];
  const done = (
    source: RobotsSource,
    finalUrl: string | null,
    statusCode: number | null,
    error: string | null,
  ) => ({
    policy: new RobotsPolicy(source, config.userAgent),
    record: { requestedUrl, finalUrl, statusCode, redirectChain, fetchedAt, error },
  });

  let url = requestedUrl;
  try {
    for (;;) {
      const res = await fetchImpl(url, {
        headers: requestHeaders(config),
        redirect: "manual",
        signal: AbortSignal.timeout(config.robotsFetchTimeoutMs),
      });
      const status = res.status;

      if (isRedirect(status)) {
        const location = res.headers.get("location");
        redirectChain.push({ url, statusCode: status });
        if (location === null) {
          return done(
            { kind: "unavailable", detail: `${status} without Location` },
            url,
            status,
            null,
          );
        }
        if (redirectChain.length > config.robotsMaxRedirects) {
          return done(
            { kind: "unavailable", detail: `more than ${config.robotsMaxRedirects} redirects` },
            url,
            status,
            null,
          );
        }
        url = new URL(location, url).toString();
        continue;
      }
      if (status >= 200 && status < 300) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const { text, truncated } = decodeRobots(bytes, config.robotsMaxBytes);
        return done({ kind: "parsed", robots: parseRobots(text, truncated) }, url, status, null);
      }
      if (status >= 400 && status < 500) {
        return done({ kind: "unavailable", detail: `HTTP ${status}` }, url, status, null);
      }
      // 5xx and anything else unexpected: unreachable → complete disallow.
      return done({ kind: "unreachable", detail: `HTTP ${status}` }, url, status, null);
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return done({ kind: "unreachable", detail: message }, url, null, message);
  }
}
