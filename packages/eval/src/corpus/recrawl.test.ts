import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SiteEntry } from "./manifest.js";
import { acquireLock, recrawlPlan, scheduleCommands } from "./recrawl.js";

const site = (id: string, o: Partial<SiteEntry> = {}): SiteEntry => ({
  id,
  url: `https://${id}.test/`,
  architectureClass: "blog",
  status: "pending",
  runId: null,
  attempts: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  commit: null,
  modelSha256: null,
  ...o,
});

const done = (id: string, finishedAt: string, runId = 1) =>
  site(id, { status: "completed", runId, finishedAt });

describe("recrawlPlan", () => {
  const base = {
    sites: [
      done("a", "2026-01-01T10:00:00.000Z"),
      done("b", "2026-01-10T10:00:00.000Z"),
      site("c", { status: "failed", finishedAt: "2026-01-01T00:00:00.000Z" }),
      done("d", "2026-01-01T10:00:00.000Z"),
      done("e", "2026-01-01T10:00:00.000Z"),
    ],
  };
  const wave = {
    sites: [
      site("a"),
      site("b"),
      site("c"),
      done("d", "2026-01-15T11:00:00.000Z", 9),
      site("e", { status: "failed" }),
    ],
  };
  const now = new Date("2026-01-15T10:00:00.000Z");

  it("runs the sites whose first run finished at least afterDays ago", () => {
    const p = recrawlPlan(base, wave, now, 14);
    expect(p.due).toEqual(["a"]);
    expect(p.waiting).toEqual([{ id: "b", dueAt: "2026-01-24T10:00:00.000Z" }]);
    expect(p.skipped).toEqual([
      { id: "c", reason: "first run failed" },
      { id: "d", reason: "re-crawled (run 9)" },
      { id: "e", reason: "re-crawl failed (use --retry-failed)" },
    ]);
  });

  it("is due exactly on the day, not a millisecond before", () => {
    expect(recrawlPlan(base, wave, new Date("2026-01-15T09:59:59.999Z"), 14).due).toEqual([]);
    expect(recrawlPlan(base, wave, new Date("2026-01-15T10:00:00.000Z"), 14).due).toEqual(["a"]);
  });

  it("the manual trigger ignores the date; --only and --retry-failed narrow and widen", () => {
    expect(recrawlPlan(base, wave, now, 14, { force: true }).due).toEqual(["a", "b"]);
    expect(recrawlPlan(base, wave, now, 14, { force: true, only: ["b"] }).due).toEqual(["b"]);
    expect(recrawlPlan(base, wave, now, 14, { retryFailed: true }).due).toEqual(["a", "e"]);
  });

  it("resumes an interrupted re-crawl whatever the date", () => {
    const running = { sites: [site("b", { status: "running", runId: 7 })] };
    expect(recrawlPlan({ sites: [base.sites[1] as SiteEntry] }, running, now, 14).due).toEqual([
      "b",
    ]);
  });
});

describe("acquireLock", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const lockPath = () => {
    const d = mkdtempSync(join(tmpdir(), "linklens-lock-"));
    dirs.push(d);
    return join(d, ".lock");
  };

  it("is exclusive while held, and released for the next taker", () => {
    const path = lockPath();
    const release = acquireLock(path);
    expect(release).not.toBeNull();
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    // Another live process holds it (the parent of this test process is alive).
    writeFileSync(path, String(process.ppid));
    expect(acquireLock(path)).toBeNull();
    writeFileSync(path, String(process.pid));
    release?.();
    expect(existsSync(path)).toBe(false);
    expect(acquireLock(path)).not.toBeNull();
  });

  it("takes over a stale lock whose process is gone", () => {
    const path = lockPath();
    writeFileSync(path, "999999999");
    const release = acquireLock(path);
    expect(release).not.toBeNull();
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    release?.();
  });
});

describe("scheduleCommands", () => {
  it("runs the recrawl command daily at the given time", () => {
    const c = scheduleCommands(
      "D:/repo",
      "pilot",
      "D:/repo/results/corpus/pilot/recrawl/recrawl.log",
      "03:30",
    );
    expect(c.cron).toBe(
      '30 3 * * * cd "D:/repo" && pnpm --filter @linklens/eval corpus recrawl --batch pilot >> "D:/repo/results/corpus/pilot/recrawl/recrawl.log" 2>&1',
    );
    expect(c.windows).toMatch(
      /^schtasks \/Create \/TN "LinkLens re-crawl pilot" \/SC DAILY \/ST 03:30 /,
    );
    expect(c.windows).toContain("corpus recrawl --batch pilot");
  });
});
