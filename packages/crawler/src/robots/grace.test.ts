import { describe, expect, it } from "vitest";
import { applyUnreachableGrace, isUnreachable, unreachableSince } from "./grace.js";
import { RobotsPolicy } from "./policy.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-06-01T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY);
const unreachable = new RobotsPolicy({ kind: "unreachable", detail: "HTTP 503" }, "LinkLensBot");

describe("isUnreachable", () => {
  it.each([
    [null, false, true],
    [500, false, true],
    [503, false, true],
    [200, false, false],
    [404, false, false],
    [429, false, false],
    [429, true, true],
  ])("status %s (treat429=%s) → %s", (statusCode, treat429, expected) => {
    expect(isUnreachable({ fetchedAt: now, statusCode }, treat429)).toBe(expected);
  });
});

describe("unreachableSince", () => {
  it("returns the start of the current unbroken unreachable streak", () => {
    const history = [
      { fetchedAt: daysAgo(0), statusCode: 503 },
      { fetchedAt: daysAgo(10), statusCode: null },
      { fetchedAt: daysAgo(40), statusCode: 500 },
      { fetchedAt: daysAgo(50), statusCode: 200 }, // streak ends here
      { fetchedAt: daysAgo(90), statusCode: 503 },
    ];
    expect(unreachableSince(history)).toEqual(daysAgo(40));
  });

  it("is null when the latest fetch was reachable or there is no history", () => {
    expect(unreachableSince([{ fetchedAt: now, statusCode: 200 }])).toBeNull();
    expect(unreachableSince([])).toBeNull();
  });
});

describe("applyUnreachableGrace (RFC 9309 §2.3.1.4)", () => {
  it("keeps complete disallow while the streak is shorter than the grace period", () => {
    const p = applyUnreachableGrace(
      unreachable,
      [
        { fetchedAt: now, statusCode: 503 },
        { fetchedAt: daysAgo(29), statusCode: 503 },
      ],
      now,
      30,
    );
    expect(p).toBe(unreachable);
    expect(p.isAllowed("https://e.com/x")).toBe(false);
  });

  it("switches to allow all once unreachable for the grace period", () => {
    const p = applyUnreachableGrace(
      unreachable,
      [
        { fetchedAt: now, statusCode: 503 },
        { fetchedAt: daysAgo(30), statusCode: 502 },
      ],
      now,
      30,
    );
    expect(p.source.kind).toBe("unavailable");
    expect(p.source.kind === "unavailable" && p.source.detail).toMatch(/≥ 30 days.*HTTP 503/);
    expect(p.isAllowed("https://e.com/x")).toBe(true);
    expect(p.userAgent).toBe("LinkLensBot");
  });

  it("counts 429s only when treat429 is set", () => {
    const history = [
      { fetchedAt: now, statusCode: 503 },
      { fetchedAt: daysAgo(40), statusCode: 429 },
    ];
    expect(applyUnreachableGrace(unreachable, history, now, 30).source.kind).toBe("unreachable");
    expect(applyUnreachableGrace(unreachable, history, now, 30, true).source.kind).toBe(
      "unavailable",
    );
  });

  it("leaves parsed and unavailable policies untouched", () => {
    const parsed = RobotsPolicy.fromText("user-agent: *\ndisallow: /", "a");
    const history = [{ fetchedAt: daysAgo(99), statusCode: 503 }];
    expect(applyUnreachableGrace(parsed, history, now, 30)).toBe(parsed);
  });
});
