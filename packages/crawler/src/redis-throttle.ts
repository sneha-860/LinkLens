import type { Redis } from "ioredis";
import type { LinkLensConfig } from "@linklens/core";
import { hostKey, systemClock, type Clock } from "./throttle.js";

/**
 * Phase 1: take the host's slot. Returns 0 when granted (the caller now holds the slot and must
 * call MARK right after dispatching), else ms to wait. Uses Redis TIME: one clock for all processes.
 * KEYS: 1 = last dispatch, 2 = robots Crawl-delay, 3 = slot holder. ARGV: 1 = config.crawlDelayMs,
 * 2 = holder lease ms (bounds how long a crashed holder can block the host).
 */
const TAKE_SLOT = `
if redis.call('EXISTS', KEYS[3]) == 1 then return -1 end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local delay = tonumber(ARGV[1])
local robots = tonumber(redis.call('GET', KEYS[2]) or '0')
if robots > delay then delay = robots end
local last = tonumber(redis.call('GET', KEYS[1]) or '-1')
if last >= 0 and now < last + delay + 1 then return last + delay + 1 - now end
redis.call('SET', KEYS[3], '1', 'PX', tonumber(ARGV[2]))
return 0
`;

/**
 * Phase 2: the holder has dispatched. Record the dispatch time (taken *after* the request left)
 * and release the slot. The +1 ms in TAKE_SLOT covers TIME's millisecond truncation.
 */
const MARK = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.ceil(tonumber(t[2]) / 1000)
redis.call('SET', KEYS[1], now, 'PX', 3600000)
redis.call('DEL', KEYS[3])
return now
`;

/** How long a waiter sleeps while another process holds the slot (it is released within ms). */
const HELD_POLL_MS = 2;
const HOLDER_LEASE_MS = 10_000;

/** Per-host politeness. HostThrottle (in-process) and RedisHostThrottle both satisfy it. */
export interface Throttle {
  /** Wait until a request to this host may be sent. */
  acquire(url: string | URL): Promise<number>;
  /** Call immediately after the request has been dispatched (or abandoned) after `acquire`. */
  dispatched?(url: string | URL): Promise<void> | void;
  setRobotsCrawlDelay(url: string | URL, delayMs: number | null): Promise<void> | void;
}

/**
 * Distributed version of HostThrottle. Consecutive dispatches to one host, from any process or
 * run, are at least max(config.crawlDelayMs, robots Crawl-delay) apart in real time:
 *  - `acquire` grants the host's single slot only once `delay` has passed since the previous
 *    dispatch was *marked*; only one holder at a time;
 *  - `dispatched` marks the time after the request was sent and frees the slot.
 * So the next request always starts at least `delay` after the previous one actually went out.
 *
 * Keys (per host, all expiring): `<prefix>:throttle:{last,robots-delay,holder}:<host>`. The
 * Crawl-delay belongs to the host, not the run, so a run that has not read robots.txt yet still
 * waits for it; it expires with the robots.txt cache TTL.
 */
export class RedisHostThrottle implements Throttle {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly config: Readonly<Pick<LinkLensConfig, "crawlDelayMs" | "robotsCacheTtlMs">>,
    private readonly clock: Clock = systemClock,
  ) {}

  private key(kind: "last" | "robots-delay" | "holder", url: string | URL): string {
    return `${this.prefix}:throttle:${kind}:${hostKey(url)}`;
  }

  async setRobotsCrawlDelay(url: string | URL, delayMs: number | null): Promise<void> {
    const key = this.key("robots-delay", url);
    if (delayMs === null) await this.redis.del(key);
    else {
      await this.redis.set(key, String(Math.max(0, delayMs)), "PX", this.config.robotsCacheTtlMs);
    }
  }

  async acquire(url: string | URL): Promise<number> {
    const keys = [this.key("last", url), this.key("robots-delay", url), this.key("holder", url)];
    let waited = 0;
    for (;;) {
      const r = Number(
        await this.redis.eval(
          TAKE_SLOT,
          3,
          ...keys,
          String(this.config.crawlDelayMs),
          String(HOLDER_LEASE_MS),
        ),
      );
      if (r === 0) return waited;
      const wait = r < 0 ? HELD_POLL_MS : r;
      await this.clock.sleep(wait);
      waited += wait;
    }
  }

  async dispatched(url: string | URL): Promise<void> {
    await this.redis.eval(
      MARK,
      3,
      this.key("last", url),
      this.key("robots-delay", url),
      this.key("holder", url),
    );
  }
}
