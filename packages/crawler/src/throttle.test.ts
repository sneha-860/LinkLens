import { describe, expect, it } from "vitest";
import { HostThrottle, hostKey, TokenBucket, type Clock } from "./throttle.js";

/** Manually advanced clock; sleep records the duration and advances time. */
function fakeClock(start = 0): Clock & { t: number; sleeps: number[]; advance(ms: number): void } {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep(ms: number) {
      c.sleeps.push(ms);
      c.t += ms;
      return Promise.resolve();
    },
    advance(ms: number) {
      c.t += ms;
    },
  };
  return c;
}

describe("TokenBucket", () => {
  it("starts full and then spaces reservations one interval apart", () => {
    const clock = fakeClock();
    const b = new TokenBucket(1, 500, clock);
    expect([b.reserve(), b.reserve(), b.reserve()]).toEqual([0, 500, 1000]);
  });

  it("refills with elapsed time, capped at capacity", () => {
    const clock = fakeClock();
    const b = new TokenBucket(1, 500, clock);
    b.reserve();
    clock.advance(200);
    expect(b.reserve()).toBe(300);
    clock.advance(10_000);
    expect(b.reserve()).toBe(0); // idle time does not build up a burst beyond capacity
    expect(b.reserve()).toBe(500);
  });

  it("allows bursts up to capacity", () => {
    const b = new TokenBucket(3, 100, fakeClock());
    expect([b.reserve(), b.reserve(), b.reserve(), b.reserve()]).toEqual([0, 0, 0, 100]);
  });

  it("never waits with a zero interval", () => {
    const b = new TokenBucket(1, 0, fakeClock());
    expect([b.reserve(), b.reserve(), b.reserve()]).toEqual([0, 0, 0]);
  });

  it("applies a changed interval to later reservations", () => {
    const clock = fakeClock();
    const b = new TokenBucket(1, 500, clock);
    b.reserve();
    b.setInterval(2000);
    expect(b.interval).toBe(2000);
    expect(b.reserve()).toBe(2000);
  });

  it("validates arguments", () => {
    expect(() => new TokenBucket(0, 1, fakeClock())).toThrow(RangeError);
    expect(() => new TokenBucket(1, -1, fakeClock())).toThrow(RangeError);
    expect(() => new TokenBucket(1, 1, fakeClock()).setInterval(-5)).toThrow(RangeError);
  });
});

describe("hostKey", () => {
  it("uses the lower-cased host including a non-default port", () => {
    expect(hostKey("https://WWW.Example.com/a")).toBe("www.example.com");
    expect(hostKey("https://example.com:8443/")).toBe("example.com:8443");
    expect(hostKey("https://example.com:443/")).toBe("example.com");
  });
});

describe("HostThrottle", () => {
  const config = { crawlDelayMs: 500 };

  it("delay = config.crawlDelayMs when robots has no Crawl-delay", () => {
    const t = new HostThrottle(config, fakeClock());
    expect(t.delayFor("https://a.com/")).toBe(500);
  });

  it("delay = max(config.crawlDelayMs, robots Crawl-delay)", () => {
    const t = new HostThrottle(config, fakeClock());
    t.setRobotsCrawlDelay("https://slow.com/", 3000);
    t.setRobotsCrawlDelay("https://fast.com/", 100);
    expect(t.delayFor("https://slow.com/x")).toBe(3000);
    expect(t.delayFor("https://fast.com/x")).toBe(500); // robots cannot make us faster than config
  });

  it("clears a robots delay with null and clamps negatives", () => {
    const t = new HostThrottle(config, fakeClock());
    t.setRobotsCrawlDelay("https://a.com/", 3000);
    t.setRobotsCrawlDelay("https://a.com/", null);
    expect(t.delayFor("https://a.com/")).toBe(500);
    t.setRobotsCrawlDelay("https://a.com/", -10);
    expect(t.delayFor("https://a.com/")).toBe(500);
  });

  it("spaces requests to one host and keeps hosts independent", () => {
    const t = new HostThrottle(config, fakeClock());
    expect(t.reserve("https://a.com/1")).toBe(0);
    expect(t.reserve("https://b.com/1")).toBe(0);
    expect(t.reserve("https://a.com/2")).toBe(500);
    expect(t.reserve("https://A.COM/3")).toBe(1000); // same host, different case
    expect(t.reserve("https://b.com/2")).toBe(500);
  });

  it("applies a robots Crawl-delay learned after the host's first request", () => {
    const t = new HostThrottle(config, fakeClock());
    t.reserve("https://a.com/");
    t.setRobotsCrawlDelay("https://a.com/", 2000);
    expect(t.reserve("https://a.com/x")).toBe(2000);
  });

  it("acquire sleeps for the reserved wait", async () => {
    const clock = fakeClock();
    const t = new HostThrottle(config, clock);
    expect(await t.acquire("https://a.com/")).toBe(0);
    expect(await t.acquire("https://a.com/")).toBe(500);
    expect(clock.sleeps).toEqual([500]);
    expect(clock.t).toBe(500);
  });

  it("keeps the minimum gap between dispatches even when a timer fires late", async () => {
    const clock = fakeClock();
    let late = 12; // the first sleep overshoots by 12 ms
    clock.sleep = (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms + late;
      late = 0;
      return Promise.resolve();
    };
    const t = new HostThrottle(config, clock);
    await t.acquire("https://a.com/"); // dispatched at 0
    await t.acquire("https://a.com/");
    const second = clock.t; // 512 (timer fired late)
    await t.acquire("https://a.com/");
    // A pure bucket would dispatch at 1000, only 488 ms after the late second request.
    expect(clock.t - second).toBeGreaterThanOrEqual(500);
  });

  it("spaces the first page request after the robots.txt request by the learned delay", async () => {
    const clock = fakeClock();
    const t = new HostThrottle({ crawlDelayMs: 0 }, clock);
    await t.acquire("https://a.com/robots.txt");
    t.setRobotsCrawlDelay("https://a.com/", 300);
    expect(await t.acquire("https://a.com/")).toBe(300);
  });

  it("queues concurrent acquires one delay apart", () => {
    const t = new HostThrottle(config, fakeClock());
    const waits = [0, 1, 2, 3].map(() => t.reserve("https://a.com/"));
    expect(waits).toEqual([0, 500, 1000, 1500]);
  });

  it("uses the real clock by default", async () => {
    const t = new HostThrottle({ crawlDelayMs: 20 });
    await t.acquire("https://a.com/");
    const start = Date.now();
    await t.acquire("https://a.com/");
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
