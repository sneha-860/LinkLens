import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import type { Manifest } from "./manifest.js";

/** A batch's re-crawl wave lives in `<batch dir>/recrawl` (its own manifest). */
export const RECRAWL_DIR = "recrawl";

export interface RecrawlPlan {
  /** Sites to crawl now, in corpus order (pending, or interrupted and resumable). */
  readonly due: string[];
  /** Sites not due yet, with when they will be. */
  readonly waiting: { readonly id: string; readonly dueAt: string }[];
  /** Sites that will not be re-crawled now, and why. */
  readonly skipped: { readonly id: string; readonly reason: string }[];
}

const DAY_MS = 86_400_000;

/**
 * Pure: which sites of the re-crawl wave are due at `now`. A site is due `afterDays` after its
 * first run finished (that run must have completed). Completed re-crawls are done; failed ones
 * wait for `retryFailed`. `force` (the manual trigger) ignores the due date.
 */
export function recrawlPlan(
  base: Pick<Manifest, "sites">,
  wave: Pick<Manifest, "sites">,
  now: Date,
  afterDays: number,
  options: {
    readonly force?: boolean;
    readonly retryFailed?: boolean;
    readonly only?: readonly string[];
  } = {},
): RecrawlPlan {
  const only = options.only === undefined ? null : new Set(options.only);
  const due: string[] = [];
  const waiting: { id: string; dueAt: string }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const again = new Map(wave.sites.map((s) => [s.id, s]));
  for (const first of base.sites) {
    if (only !== null && !only.has(first.id)) continue;
    const second = again.get(first.id);
    if (second === undefined) {
      skipped.push({ id: first.id, reason: "not in the re-crawl wave" });
      continue;
    }
    if (second.status === "completed") {
      skipped.push({ id: first.id, reason: `re-crawled (run ${second.runId})` });
      continue;
    }
    if (second.status === "failed" && options.retryFailed !== true) {
      skipped.push({ id: first.id, reason: "re-crawl failed (use --retry-failed)" });
      continue;
    }
    if (first.status !== "completed" || first.finishedAt === null) {
      skipped.push({ id: first.id, reason: `first run ${first.status}` });
      continue;
    }
    const dueAt = new Date(Date.parse(first.finishedAt) + afterDays * DAY_MS);
    // An interrupted re-crawl is resumed whatever the date: its run exists already.
    if (options.force === true || second.status === "running" || dueAt.getTime() <= now.getTime()) {
      due.push(first.id);
    } else {
      waiting.push({ id: first.id, dueAt: dueAt.toISOString() });
    }
  }
  return { due, waiting, skipped };
}

/**
 * Take an exclusive lock file (a scheduled re-crawl must not overlap one still running). A lock
 * whose process is gone is stale and taken over. Returns the release function, or null when a
 * live process holds the lock.
 */
export function acquireLock(path: string, pid = process.pid): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8") === String(pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = Number(existsSync(path) ? readFileSync(path, "utf8") : NaN);
      if (Number.isInteger(holder) && holder !== pid && alive(holder)) return null;
      try {
        unlinkSync(path); // stale
      } catch {
        // raced with another taker
      }
    }
  }
  return null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lines that run the re-crawl every day (it only crawls the sites that are due). */
export function scheduleCommands(
  repo: string,
  batch: string,
  logFile: string,
  at: string,
): { windows: string; cron: string } {
  const [hh, mm] = at.split(":");
  const cmd = `pnpm --filter @linklens/eval corpus recrawl --batch ${batch}`;
  return {
    windows:
      `schtasks /Create /TN "LinkLens re-crawl ${batch}" /SC DAILY /ST ${at} ` +
      `/TR "cmd /c cd /d \\"${repo}\\" && ${cmd} >> \\"${logFile}\\" 2>&1"`,
    cron: `${Number(mm)} ${Number(hh)} * * * cd "${repo}" && ${cmd} >> "${logFile}" 2>&1`,
  };
}
