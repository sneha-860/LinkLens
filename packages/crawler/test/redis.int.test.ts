import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Redis } from "ioredis";
import { makeConfig } from "@linklens/core";
import { Frontier } from "../src/frontier.js";
import { RedisHostThrottle } from "../src/redis-throttle.js";

let redis: Redis;
let prefix: string;

beforeAll(() => {
  redis = new Redis(inject("redisUrl"));
});
afterAll(async () => {
  const keys = await redis.keys("linklens_test_*");
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});
beforeEach(() => {
  prefix = `linklens_test_${randomBytes(4).toString("hex")}`;
});

describe("Frontier", () => {
  it("admits each key once, up to the cap, atomically", async () => {
    const f = new Frontier(redis, `${prefix}:run:1`, 3);
    expect(await f.exists()).toBe(false);
    expect(await f.admit("a")).toBe("admitted");
    expect(await f.admit("a")).toBe("seen");
    const results = await Promise.all(["b", "c", "d", "e", "b"].map((k) => f.admit(k)));
    expect(results.filter((r) => r === "admitted")).toHaveLength(2); // a + 2 = cap 3
    expect(await f.admittedCount()).toBe(3);
    expect(await f.exists()).toBe(true);
  });

  it("markSeen dedupes without counting toward the cap", async () => {
    const f = new Frontier(redis, `${prefix}:run:2`, 1);
    expect(await f.markSeen("redirect-target")).toBe(true);
    expect(await f.markSeen("redirect-target")).toBe(false);
    expect(await f.admit("redirect-target")).toBe("seen");
    expect(await f.admit("x")).toBe("admitted");
    expect(await f.admit("y")).toBe("cap-reached");
  });

  it("counts finished URLs, flags cancellation, and clears everything", async () => {
    const f = new Frontier(redis, `${prefix}:run:3`, 10);
    await f.admit("a");
    expect(await f.incrFinished()).toBe(1);
    expect(await f.incrFinished()).toBe(2);
    expect(await f.finishedCount()).toBe(2);
    expect(await f.isCancelled()).toBe(false);
    await f.requestCancel();
    expect(await f.isCancelled()).toBe(true);
    await f.clear();
    expect(await redis.keys(`${prefix}:run:3*`)).toEqual([]);
    expect(await f.exists()).toBe(false);
  });
});

describe("RedisHostThrottle", () => {
  const config = makeConfig({ crawlDelayMs: 30, robotsCacheTtlMs: 60_000 });

  /** Acquire, "dispatch" (record the time), then mark, like fetchPage does. */
  async function hit(t: RedisHostThrottle, url: string, log: number[]): Promise<void> {
    await t.acquire(url);
    log.push(performance.now());
    await t.dispatched(url);
  }

  it("spaces dispatches from independent instances (separate processes) by the delay", async () => {
    const a = new RedisHostThrottle(redis, prefix, config);
    const b = new RedisHostThrottle(redis, prefix, config);
    const log: number[] = [];
    await Promise.all([
      (async () => {
        for (let i = 0; i < 4; i++) await hit(a, "https://h.test/a", log);
      })(),
      (async () => {
        for (let i = 0; i < 4; i++) await hit(b, "https://h.test/b", log);
      })(),
    ]);
    log.sort((x, y) => x - y);
    const gaps = log.slice(1).map((t, i) => t - (log[i] ?? 0));
    expect(log).toHaveLength(8);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(30);
  });

  it("keeps hosts independent", async () => {
    const t = new RedisHostThrottle(redis, prefix, config);
    await hit(t, "https://one.test/", []);
    const start = performance.now();
    await hit(t, "https://two.test/", []);
    expect(performance.now() - start).toBeLessThan(25);
  });

  it("applies a host's robots Crawl-delay to every instance, and can clear it", async () => {
    const setter = new RedisHostThrottle(redis, prefix, config);
    const other = new RedisHostThrottle(redis, prefix, config);
    await setter.setRobotsCrawlDelay("https://slow.test/", 120);
    expect(await redis.pttl(`${prefix}:throttle:robots-delay:slow.test`)).toBeGreaterThan(59_000);

    const log: number[] = [];
    await hit(other, "https://slow.test/x", log);
    await hit(other, "https://slow.test/y", log);
    expect((log[1] ?? 0) - (log[0] ?? 0)).toBeGreaterThanOrEqual(120);

    await setter.setRobotsCrawlDelay("https://slow.test/", null);
    expect(await redis.exists(`${prefix}:throttle:robots-delay:slow.test`)).toBe(0);
  });

  it("keeps a host's last dispatch until its delay has passed, however long the delay", async () => {
    // A state TTL far shorter than the robots Crawl-delay: the last-dispatch key must still
    // outlive the delay, or the next request would go out as soon as it expired.
    const short = makeConfig({ crawlDelayMs: 0, robotsCacheTtlMs: 60_000, throttleStateTtlMs: 20 });
    const t = new RedisHostThrottle(redis, prefix, short);
    await t.setRobotsCrawlDelay("https://patient.test/", 200);
    const log: number[] = [];
    await hit(t, "https://patient.test/a", log);
    const ttl = await redis.pttl(`${prefix}:throttle:last:patient.test`);
    expect(ttl).toBeGreaterThan(200);
    expect(ttl).toBeLessThanOrEqual(220);
    await hit(t, "https://patient.test/b", log);
    expect((log[1] ?? 0) - (log[0] ?? 0)).toBeGreaterThanOrEqual(199);

    // Hours-long delays too (a robots Crawl-delay of 7200 s), which the old fixed 1 h TTL dropped.
    await t.setRobotsCrawlDelay("https://slowest.test/", 7_200_000);
    await t.acquire("https://slowest.test/");
    await t.dispatched("https://slowest.test/");
    expect(await redis.pttl(`${prefix}:throttle:last:slowest.test`)).toBeGreaterThan(7_199_000);
  });

  it("frees a host held by a crashed process once the lease expires", async () => {
    // Simulate a holder that never called dispatched(): a short-lived holder key.
    await redis.set(`${prefix}:throttle:holder:stuck.test`, "1", "PX", 100);
    const t = new RedisHostThrottle(redis, prefix, config);
    const start = performance.now();
    await t.acquire("https://stuck.test/");
    await t.dispatched("https://stuck.test/");
    expect(performance.now() - start).toBeGreaterThanOrEqual(90);
  });
});
