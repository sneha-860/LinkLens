import { describe, expect, it } from "vitest";
import { makeConfig } from "@linklens/core";
import { jobOptions, mayFollow } from "./orchestrator.js";

// The orchestrator's Redis/BullMQ/Postgres behaviour is covered by test/crawl.int.test.ts;
// these are its pure decisions.

describe("jobOptions", () => {
  const config = makeConfig({ fetchMaxRetries: 2, retryBackoffMs: 250 });

  it("prioritises by depth (BFS) and retries with exponential backoff", () => {
    expect(jobOptions(config, 0)).toEqual({
      priority: 1,
      attempts: 3,
      backoff: { type: "exponential", delay: 250 },
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(jobOptions(config, 4).priority).toBe(5);
  });

  it("caps priority at BullMQ's maximum", () => {
    expect(jobOptions(config, 10_000_000).priority).toBe(2_097_151);
  });

  it("makes exactly one attempt when retries are disabled", () => {
    expect(jobOptions(makeConfig({ fetchMaxRetries: 0 }), 0).attempts).toBe(1);
  });
});

describe("mayFollow", () => {
  const follow = { followNofollow: true };
  const strict = { followNofollow: false };

  it("follows everything when followNofollow is on", () => {
    expect(mayFollow(follow, true, "nofollow")).toBe(true);
  });

  it("skips rel=nofollow links and all links of meta-nofollow pages when off", () => {
    expect(mayFollow(strict, false, null)).toBe(true);
    expect(mayFollow(strict, false, "noopener")).toBe(true);
    expect(mayFollow(strict, false, "nofollow")).toBe(false);
    expect(mayFollow(strict, false, "noopener NoFollow")).toBe(false);
    expect(mayFollow(strict, true, null)).toBe(false);
  });
});
