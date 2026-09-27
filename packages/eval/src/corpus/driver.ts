import { setTimeout as sleep } from "node:timers/promises";
import { db as q } from "@linklens/core";
import type { PipelineRunner } from "@linklens/api/pipeline";
import type { AuditDriver, AuditRequest } from "./batch.js";

/**
 * Runs audits in this process through the API's PipelineRunner: the same 18 stages, stage
 * records, leases and events as an audit started from the dashboard (which shows its progress).
 */
export class PipelineDriver implements AuditDriver {
  constructor(
    private readonly runner: PipelineRunner,
    /** How often to look again while another process holds the audit's lease. */
    private readonly pollMs = runner.settings.apiAuditLeaseMs / 3,
  ) {}

  async create(site: { url: string }, audit: AuditRequest): Promise<number> {
    const row = await this.runner.create({
      url: site.url,
      policy: audit.policy,
      options: { sigma: audit.sigma, refVariant: audit.refVariant, config: audit.config },
    });
    return row.runId;
  }

  async complete(
    runId: number,
    audit: AuditRequest,
  ): Promise<{ status: "completed" | "failed"; error: string | null }> {
    const done = await this.auditDone(runId);
    if (done.status !== "completed" || !audit.rankAllPolicies) return done;
    return this.allPoliciesRanked(runId);
  }

  /**
   * `start` resumes the audit from its first stage not completed, or returns at once when
   * another process holds its lease (a live API instance, or a crashed batch whose lease has not
   * expired yet): then wait and look again until the audit is finished.
   */
  private async auditDone(
    runId: number,
  ): Promise<{ status: "completed" | "failed"; error: string | null }> {
    for (;;) {
      await this.runner.start(runId);
      const audit = await q.getAudit(this.runner.db, runId);
      if (audit === null) throw new Error(`audit ${runId} not found`);
      if (audit.status === "completed" || audit.status === "failed") {
        return { status: audit.status, error: audit.error };
      }
      if (this.stopping) return { status: "failed", error: "interrupted" };
      await sleep(this.pollMs);
    }
  }

  /**
   * The API's per-policy ranking job (policy_jobs, resumable, under its own lease): the ranking
   * stages under every policy that has no ranking for the audit's σ yet. A job that already
   * finished is started again and skips every policy, so a resumed batch never ranks twice.
   */
  private async allPoliciesRanked(
    runId: number,
  ): Promise<{ status: "completed" | "failed"; error: string | null }> {
    for (;;) {
      await this.runner.rankAllPolicies(runId);
      await this.runner.runPolicyJob(runId);
      const job = await this.runner.policyJob(runId);
      if (job?.status === "completed") return { status: "completed", error: null };
      if (job?.status === "failed") {
        return { status: "failed", error: `ranking under every policy: ${job.error ?? "failed"}` };
      }
      if (this.stopping) return { status: "failed", error: "interrupted" };
      await sleep(this.pollMs);
    }
  }

  private stopping = false;

  /** Stop in-process work; the audit in flight stays resumable (see PipelineRunner.close). */
  async close(): Promise<void> {
    this.stopping = true;
    await this.runner.close();
  }
}
