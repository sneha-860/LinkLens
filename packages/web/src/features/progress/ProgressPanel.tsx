import type { Audit } from "../../api/types.js";
import { useResumeAudit } from "../../api/queries.js";
import type { LiveState } from "../../api/useAuditEvents.js";
import { fmtMs, fmtPct, shortUrl, STAGE_NAMES } from "../../ui/format.js";
import { Badge, Button, Card, ProgressBar, StatusBadge } from "../../ui/ui.js";

const ICONS = { pending: "○", running: "◐", completed: "✓", failed: "✗" } as const;

/** Live progress: a bar over the 18 stages, the crawl counter, and each stage with its duration. */
export function ProgressPanel({ audit, live }: { audit: Audit; live: LiveState | null }) {
  const resume = useResumeAudit(audit.id);
  const stages = live?.stages ?? audit.stages;
  const done = stages.filter((s) => s.status === "completed").length;
  const running = stages.find((s) => s.status === "running");
  const failed = stages.find((s) => s.status === "failed");
  const fraction = done / Math.max(1, stages.length);
  const status = failed !== undefined && !audit.active ? "failed" : audit.status;

  return (
    <Card
      title={
        <span className="row">
          Progress <StatusBadge status={status} />
          {live?.connected === true && <Badge tone="info">live</Badge>}
        </span>
      }
      actions={
        status === "failed" && !audit.active ? (
          <Button variant="secondary" onClick={() => resume.mutate()} disabled={resume.isPending}>
            Resume from {STAGE_NAMES[failed?.stage ?? ""] ?? "the failed stage"}
          </Button>
        ) : undefined
      }
    >
      <ProgressBar fraction={fraction} label="Pipeline progress" />
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <span>
          {done} of {stages.length} stages · {fmtPct(fraction)}
          {running !== undefined && <> · now: {STAGE_NAMES[running.stage] ?? running.stage}</>}
        </span>
        {running?.stage === "crawl" && live?.crawl !== null && live?.crawl !== undefined && (
          <span className="mono" title={live.crawl.url}>
            {live.crawl.pagesFetched} / {live.crawl.admitted} URLs · {shortUrl(live.crawl.url)}
          </span>
        )}
      </div>
      {(failed?.error ?? audit.error) && (
        <div className="error" role="alert" style={{ marginTop: 12 }}>
          {STAGE_NAMES[failed?.stage ?? ""] ?? "Pipeline"} failed: {failed?.error ?? audit.error}
        </div>
      )}
      <ol className="stages" aria-label="Stages">
        {stages.map((s) => (
          <li key={s.stage} className={`stage stage-${s.status}`} data-status={s.status}>
            <span aria-hidden="true">{ICONS[s.status]}</span>
            {STAGE_NAMES[s.stage] ?? s.stage}
            <span className="stage-time">{fmtMs(s.durationMs)}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
