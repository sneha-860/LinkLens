import type { LinkLensConfig } from "@linklens/core";
import type { Corpus } from "./corpus.js";
import type { Manifest, SiteEntry } from "./manifest.js";

/** How the batch runs one audit (the API's PipelineRunner in production; a fake in tests). */
export interface AuditDriver {
  /** Create the run and its audit; returns the run id. */
  create(site: { url: string }, audit: AuditRequest): Promise<number>;
  /**
   * Run (or resume) the audit until it completes or fails, then, with `rankAllPolicies`, the
   * ranking of fixes under every policy.
   */
  complete(
    runId: number,
    audit: AuditRequest,
  ): Promise<{ status: "completed" | "failed"; error: string | null }>;
}

export interface AuditRequest {
  readonly policy: Corpus["policy"];
  readonly sigma: Corpus["sigma"];
  readonly refVariant: Corpus["refVariant"];
  /** Also rank fixes under every other policy once the audit completes. */
  readonly rankAllPolicies: boolean;
  /** The full config (stored as the run's config). */
  readonly config: Readonly<LinkLensConfig>;
}

export interface BatchHooks {
  /** Persist the manifest (called after every change of a site's state). */
  save(m: Manifest): void;
  /** The commit and model hash to stamp on a finished site. */
  stamp(): { commit: string | null; modelSha256: string | null };
  log(message: string): void;
  now(): string;
  /** True once the batch should stop (SIGINT): the current site is left resumable. */
  stopped(): boolean;
}

export interface BatchOptions {
  /** Re-run sites whose audit failed (default: leave them failed). */
  readonly retryFailed?: boolean;
  /** Only these site ids (default: all), still in corpus order. */
  readonly only?: readonly string[];
}

export interface BatchSummary {
  readonly completed: number;
  readonly failed: number;
  readonly pending: number;
  readonly stopped: boolean;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Audit the corpus's sites one after another. The manifest is the batch state: each site's run
 * id is saved as soon as the run exists, so an interrupted batch resumes it (the pipeline
 * continues from its first stage not completed, the crawl from its Redis frontier) instead of
 * starting a new crawl. Completed sites are skipped; failed ones only with retryFailed.
 */
export async function runBatch(
  manifest: Manifest,
  audit: AuditRequest,
  driver: AuditDriver,
  hooks: BatchHooks,
  options: BatchOptions = {},
): Promise<BatchSummary> {
  const only = options.only === undefined ? null : new Set(options.only);
  if (only !== null) {
    const unknown = [...only].filter((id) => !manifest.sites.some((s) => s.id === id));
    if (unknown.length > 0) throw new Error(`unknown site id(s): ${unknown.join(", ")}`);
  }
  const touch = () => {
    manifest.updatedAt = hooks.now();
    hooks.save(manifest);
  };

  let ran = 0;
  for (const [i, site] of manifest.sites.entries()) {
    if (hooks.stopped()) break;
    if (only !== null && !only.has(site.id)) continue;
    if (site.status === "completed") continue;
    if (site.status === "failed" && options.retryFailed !== true) continue;
    const label = `[${i + 1}/${manifest.sites.length}] ${site.id}`;
    await runSite(site, label, audit, driver, hooks, touch);
    ran += 1;
  }

  const count = (s: SiteEntry["status"]) => manifest.sites.filter((x) => x.status === s).length;
  const stopped = hooks.stopped();
  const settled = manifest.sites.every((s) => s.status === "completed" || s.status === "failed");
  // Finished when the last site settles (a session with nothing to do keeps the old time).
  if (!stopped && settled && (ran > 0 || manifest.finishedAt === null)) {
    manifest.finishedAt = hooks.now();
    touch();
  }
  return {
    completed: count("completed"),
    failed: count("failed"),
    pending: count("pending") + count("running"),
    stopped,
  };
}

async function runSite(
  site: SiteEntry,
  label: string,
  audit: AuditRequest,
  driver: AuditDriver,
  hooks: BatchHooks,
  touch: () => void,
): Promise<void> {
  const resuming = site.runId !== null && site.status !== "failed";
  site.status = "running";
  site.attempts += 1;
  site.startedAt ??= hooks.now();
  site.error = null;
  touch();
  try {
    if (site.runId === null) {
      site.runId = await driver.create({ url: site.url }, audit);
      touch();
      hooks.log(`${label}: run ${site.runId} started (${site.url})`);
    } else {
      hooks.log(`${label}: ${resuming ? "resuming" : "retrying"} run ${site.runId}`);
    }
    const r = await driver.complete(site.runId, audit);
    if (hooks.stopped() && r.status !== "completed") {
      // Interrupted mid-site: leave it running so the next session resumes the same run.
      hooks.log(`${label}: interrupted; run ${site.runId} stays resumable`);
      touch();
      return;
    }
    site.status = r.status;
    site.error = r.error;
  } catch (e) {
    if (hooks.stopped()) {
      touch();
      return;
    }
    site.status = "failed";
    site.error = errorText(e);
  }
  site.finishedAt = hooks.now();
  const stamp = hooks.stamp();
  site.commit = stamp.commit;
  site.modelSha256 = stamp.modelSha256;
  touch();
  hooks.log(
    `${label}: ${site.status}${site.error === null ? "" : ` (${site.error})`}` +
      (site.runId === null ? "" : ` [run ${site.runId}]`),
  );
}
