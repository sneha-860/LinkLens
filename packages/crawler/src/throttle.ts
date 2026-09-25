import type { LinkLensConfig } from "@linklens/core";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Token bucket with reservations. Tokens refill at one per `intervalMs` up to `capacity`.
 * `reserve()` always takes a token, letting the balance go negative, and returns how long the
 * caller must wait for it. Concurrent callers therefore queue in order, one interval apart.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private intervalMs: number,
    private readonly clock: Clock,
  ) {
    if (capacity < 1) throw new RangeError("capacity must be ≥ 1");
    if (intervalMs < 0) throw new RangeError("intervalMs must be ≥ 0");
    this.tokens = capacity;
    this.last = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    if (this.intervalMs === 0) {
      this.tokens = this.capacity;
    } else {
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) / this.intervalMs);
    }
    this.last = now;
  }

  /** Take a token; returns the wait in ms before it may be used (0 if available now). */
  reserve(): number {
    this.refill();
    this.tokens -= 1;
    return this.tokens >= 0 ? 0 : Math.ceil(-this.tokens * this.intervalMs);
  }

  get interval(): number {
    return this.intervalMs;
  }

  /** Change the refill interval. Tokens accrued so far at the old rate are kept. */
  setInterval(intervalMs: number): void {
    if (intervalMs < 0) throw new RangeError("intervalMs must be ≥ 0");
    this.refill();
    this.intervalMs = intervalMs;
  }
}

/** Host key for throttling: lower-cased `host` (hostname plus non-default port). */
export function hostKey(url: string | URL): string {
  return (typeof url === "string" ? new URL(url) : url).host.toLowerCase();
}

/**
 * Per-host politeness throttle. Each host has a capacity-1 token bucket (no bursts), so
 * consecutive requests to one host are at least `delayFor(host)` ms apart, where
 * delay = max(config.crawlDelayMs, robots.txt Crawl-delay for that host).
 */
export class HostThrottle {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly robotsDelays = new Map<string, number>();
  private readonly lastDispatch = new Map<string, number>();

  constructor(
    private readonly config: Readonly<Pick<LinkLensConfig, "crawlDelayMs">>,
    private readonly clock: Clock = systemClock,
  ) {}

  delayFor(url: string | URL): number {
    return Math.max(this.config.crawlDelayMs, this.robotsDelays.get(hostKey(url)) ?? 0);
  }

  /** Record the robots.txt Crawl-delay (ms) for a host; null clears it. */
  setRobotsCrawlDelay(url: string | URL, delayMs: number | null): void {
    const key = hostKey(url);
    if (delayMs === null) this.robotsDelays.delete(key);
    else this.robotsDelays.set(key, Math.max(0, delayMs));
    this.buckets.get(key)?.setInterval(this.delayFor(url));
  }

  /** Reserve the next slot for this host without waiting; returns the wait in ms. */
  reserve(url: string | URL): number {
    const key = hostKey(url);
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = new TokenBucket(1, this.delayFor(url), this.clock);
      this.buckets.set(key, bucket);
    }
    return bucket.reserve();
  }

  /**
   * Wait until a request to this host is allowed. Resolves with the time waited in ms.
   *
   * On top of the bucket reservation, this enforces the delay as a minimum gap since the previous
   * actual dispatch: timers can fire late, and a pure token bucket would let the next request
   * catch up, sending two requests closer together than the delay.
   */
  async acquire(url: string | URL): Promise<number> {
    const key = hostKey(url);
    const start = this.clock.now();
    const wait = this.reserve(url);
    if (wait > 0) await this.clock.sleep(wait);
    for (;;) {
      const last = this.lastDispatch.get(key);
      const remaining = last === undefined ? 0 : last + this.delayFor(url) - this.clock.now();
      if (remaining <= 0) break;
      await this.clock.sleep(remaining);
    }
    this.lastDispatch.set(key, this.clock.now());
    return this.clock.now() - start;
  }
}
