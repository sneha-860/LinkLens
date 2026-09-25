import type { db, LinkLensConfig } from "@linklens/core";
import { decodeBody, isHtml } from "./content.js";
import type { Throttle } from "./redis-throttle.js";
import type { RobotsPolicy } from "./robots/index.js";
import { requestHeaders } from "./user-agent.js";

export interface PageFetchDeps {
  readonly config: Readonly<LinkLensConfig>;
  readonly fetch: typeof fetch;
  /** Waits for the per-host token bucket. */
  readonly throttle: Pick<Throttle, "acquire" | "dispatched">;
  /** robots.txt policy for the URL's origin (fetched and cached by the caller). */
  readonly robots: (url: URL) => Promise<RobotsPolicy>;
  /** Same-site test applied to every redirect hop. */
  readonly inScope: (url: URL) => boolean;
  /** Aborts the in-flight request on cancellation. */
  readonly signal?: AbortSignal;
}

export type FetchOutcomeKind =
  | "ok" // a final (non-redirect) response was received, any status
  | "blocked" // robots.txt disallows the URL (or a redirect target)
  | "off-site-redirect" // a redirect left the crawl scope; not followed
  | "too-many-redirects"
  | "bad-redirect" // unparsable or non-http(s) Location
  | "network-error" // DNS, connection, TLS, timeout …
  | "cancelled";

export interface FetchOutcome {
  readonly kind: FetchOutcomeKind;
  readonly requestedUrl: string;
  /** Last URL actually requested, or null if nothing was requested. */
  readonly finalUrl: string | null;
  readonly statusCode: number | null;
  readonly headers: Record<string, string>;
  readonly contentType: string | null;
  readonly bytes: number | null;
  readonly redirectChain: db.RedirectHop[];
  readonly error: string | null;
  /** 5xx and network errors are retried. */
  readonly retryable: boolean;
  /** Decoded body, only for 2xx HTML. */
  readonly html: string | null;
  /** Raw body bytes as received, only for 2xx HTML (for fetch_bodies). */
  readonly rawBody: Uint8Array | null;
  /** True if the body was cut at maxBodyBytes. */
  readonly truncated: boolean;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

function headerObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Read at most `max` bytes of a body; cancels the stream beyond that. */
async function readCapped(
  res: Response,
  max: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (res.body === null) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - total;
    if (value.length > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { bytes, truncated };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}

/**
 * Fetch one URL for the crawl: follow redirects manually (recording every hop), check scope and
 * robots.txt before EVERY request, and wait on the per-host token bucket before each request.
 * Never throws for HTTP or network failures; the outcome says what happened.
 */
export async function fetchPage(
  url: URL,
  deps: PageFetchDeps,
  /** The URL as discovered (recorded verbatim); defaults to the WHATWG serialisation of `url`. */
  requestedUrl: string = url.toString(),
): Promise<FetchOutcome> {
  const aborted = () => deps.signal?.aborted === true;
  const chain: db.RedirectHop[] = [];
  let current = url;
  let last: { url: string; status: number; headers: Record<string, string> } | null = null;

  const outcome = (
    kind: FetchOutcomeKind,
    error: string | null,
    extra: Partial<FetchOutcome> = {},
  ): FetchOutcome => ({
    kind,
    requestedUrl,
    finalUrl: last?.url ?? null,
    statusCode: last?.status ?? null,
    headers: last?.headers ?? {},
    contentType: last?.headers["content-type"] ?? null,
    bytes: null,
    redirectChain: chain,
    error,
    retryable: false,
    html: null,
    rawBody: null,
    truncated: false,
    ...extra,
  });

  for (;;) {
    if (aborted()) return outcome("cancelled", "cancelled");

    const policy = await deps.robots(current);
    const decision = policy.check(current);
    if (!decision.allowed) {
      const why =
        decision.reason === "robots-unreachable"
          ? "robots.txt unreachable (complete disallow)"
          : `disallow ${decision.rule?.pattern ?? ""} (robots.txt line ${decision.rule?.line ?? "?"})`;
      return outcome("blocked", `blocked by robots.txt: ${current.toString()}: ${why}`);
    }
    const crawlDelay = policy.crawlDelayMs;
    if (crawlDelay !== null && crawlDelay > deps.config.maxCrawlDelayMs) {
      return outcome(
        "blocked",
        `host not crawled: robots.txt Crawl-delay ${crawlDelay} ms exceeds maxCrawlDelayMs ${deps.config.maxCrawlDelayMs}`,
      );
    }

    await deps.throttle.acquire(current);
    if (aborted()) {
      await deps.throttle.dispatched?.(current); // release the slot (counted as used: polite)
      return outcome("cancelled", "cancelled");
    }

    const timeout = AbortSignal.timeout(deps.config.fetchTimeoutMs);
    const signal = deps.signal !== undefined ? AbortSignal.any([timeout, deps.signal]) : timeout;
    let pending: Promise<Response>;
    try {
      pending = deps.fetch(current, {
        method: "GET",
        headers: requestHeaders(deps.config),
        redirect: "manual",
        signal,
      });
    } catch (err) {
      pending = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    pending.catch(() => undefined); // handled below; avoid an unhandled-rejection report meanwhile
    // Mark the dispatch only after the request has been issued, so the next one waits from here.
    await deps.throttle.dispatched?.(current);
    let res: Response;
    try {
      res = await pending;
    } catch (err) {
      if (aborted()) return outcome("cancelled", "cancelled");
      return outcome("network-error", `${current.toString()}: ${describeError(err)}`, {
        retryable: true,
      });
    }

    const headers = headerObject(res.headers);
    last = { url: current.toString(), status: res.status, headers };

    if (REDIRECT.has(res.status)) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      chain.push({ url: current.toString(), statusCode: res.status, location });
      if (location === null) return outcome("ok", null); // a 3xx with no Location is final
      if (chain.length > deps.config.maxRedirects) {
        return outcome("too-many-redirects", `more than ${deps.config.maxRedirects} redirects`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return outcome("bad-redirect", `unparsable Location: ${location}`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return outcome("bad-redirect", `non-http(s) Location: ${location}`);
      }
      if (!deps.inScope(next)) {
        return outcome("off-site-redirect", `redirect leaves crawl scope: ${next.toString()}`);
      }
      current = next;
      continue;
    }

    let body: { bytes: Uint8Array; truncated: boolean };
    try {
      body = await readCapped(res, deps.config.maxBodyBytes);
    } catch (err) {
      if (aborted()) return outcome("cancelled", "cancelled");
      return outcome("network-error", `${current.toString()}: body: ${describeError(err)}`, {
        retryable: true,
      });
    }
    const contentType = res.headers.get("content-type");
    const html = res.status >= 200 && res.status < 300 && isHtml(contentType);
    return outcome(
      "ok",
      body.truncated ? `body truncated at ${deps.config.maxBodyBytes} bytes` : null,
      {
        bytes: body.bytes.length,
        retryable: res.status >= 500,
        html: html ? decodeBody(body.bytes, contentType) : null,
        rawBody: html ? body.bytes : null,
        truncated: body.truncated,
      },
    );
  }
}
