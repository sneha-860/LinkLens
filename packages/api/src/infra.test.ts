import { describe, expect, it } from "vitest";
import { makeConfig } from "@linklens/core";
import { cookies, credential, safeEqual, sessionToken } from "./auth.js";
import { LocalEventBus } from "./events.js";
import { LocalLeases } from "./leases.js";
import type { PipelineEvent } from "./pipeline.js";
import { StageWorkerPool } from "./stage-pool.js";
import { DB_STAGES, isDbStage, type StageCtx } from "./stages.js";

const done = (runId: number): PipelineEvent => ({ type: "done", runId, status: "completed" });

describe("LocalEventBus", () => {
  it("delivers to every subscriber until it unsubscribes", async () => {
    const bus = new LocalEventBus();
    await bus.ready();
    const a: number[] = [];
    const b: number[] = [];
    const offA = bus.subscribe((e) => a.push(e.runId));
    bus.subscribe((e) => b.push(e.runId));
    bus.publish(done(1));
    offA();
    bus.publish(done(2));
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
    await bus.close();
    bus.publish(done(3));
    expect(b).toEqual([1, 2]);
  });
});

describe("LocalLeases", () => {
  it("gives a lease to one holder at a time", async () => {
    const leases = new LocalLeases();
    expect(await leases.acquire("audit:1")).toBe(true);
    expect(await leases.acquire("audit:1")).toBe(false);
    expect(await leases.isHeld("audit:1")).toBe(true);
    expect(await leases.isHeld("audit:2")).toBe(false);
    await leases.release("audit:1");
    expect(await leases.isHeld("audit:1")).toBe(false);
    expect(await leases.acquire("audit:1")).toBe(true);
  });
});

describe("auth helpers", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as never;

  it("compares in constant time and derives the cookie from the key", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(sessionToken("k")).toBe(sessionToken("k"));
    expect(sessionToken("k")).not.toBe(sessionToken("K"));
    expect(sessionToken("k")).not.toContain("k=");
  });

  it("reads cookies and tells how a request is authenticated", () => {
    expect(cookies(req({ cookie: "a=1; b=x%20y; bad; =z" }))).toEqual({ a: "1", b: "x y" });
    expect(credential(req({ authorization: "Bearer key" }), "key")).toBe("key");
    expect(credential(req({ "x-api-key": "key" }), "key")).toBe("key");
    expect(credential(req({ cookie: `linklens_session=${sessionToken("key")}` }), "key")).toBe(
      "cookie",
    );
    expect(credential(req({ authorization: "Basic key" }), "key")).toBeNull();
    expect(credential(req({ cookie: "linklens_session=key" }), "key")).toBeNull();
    expect(credential(req({}), "key")).toBeNull();
  });
});

describe("stages", () => {
  it("keeps the stages that need a crawler, an embedder or their own workers on the runner", () => {
    for (const s of ["crawl", "discovery", "embeddings", "counterfactual", "rescue"])
      expect(isDbStage(s)).toBe(false);
    expect(DB_STAGES).toContain("text");
    expect(DB_STAGES).toContain("explanations");
  });
});

describe("StageWorkerPool", () => {
  const ctx: StageCtx = {
    runId: 1,
    policy: "P3",
    policyVersion: "P3@1.0.0",
    options: {},
    config: makeConfig(),
  };

  it("runs stages in worker threads, reports their errors and reuses the workers", async () => {
    // Nothing listens on port 1: the stage fails inside the worker, and the error comes back.
    const pool = new StageWorkerPool(2, "postgres://linklens:x@127.0.0.1:1/none");
    try {
      const runs = await Promise.allSettled([
        pool.run("text", ctx),
        pool.run("graph", ctx),
        pool.run("kappa", ctx),
      ]);
      for (const r of runs) {
        expect(r.status).toBe("rejected");
        expect(String((r as PromiseRejectedResult).reason)).toMatch(/ECONNREFUSED|connect/i);
      }
      expect(pool.started).toBe(2); // the third waited for a free worker
      await expect(pool.run("text", ctx)).rejects.toThrow();
      expect(pool.started).toBe(2);
    } finally {
      await pool.close();
    }
    await expect(pool.run("text", ctx)).rejects.toThrow(/closed/);
    expect(() => new StageWorkerPool(0, "x")).toThrow(RangeError);
  }, 30_000);
});
