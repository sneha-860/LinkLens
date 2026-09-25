import { useFixes, useSummary } from "../../api/queries.js";
import { CHANNELS, type SigmaVariant, type Summary } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { CHANNEL_NAMES, fmtInt, fmtMs } from "../../ui/format.js";
import { BarList, Badge, Card, EmptyState, QueryView, Spinner, StatCard } from "../../ui/ui.js";
import { FixTable } from "../fixes/FixRow.js";

const ISSUE_NAMES: Record<string, string> = {
  orphan: "Orphan pages",
  "deep-page": "Deep pages",
  "weak-authority": "Weak authority",
  "outside-largest-scc": "Outside the main cluster",
  "dead-end": "Dead ends",
  "noindex-nofollow-conflict": "noindex / nofollow conflicts",
};

export function IssueCounts({ issues }: { issues: NonNullable<Summary["issues"]> }) {
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <Badge tone="danger">{issues.bySeverity.high} high</Badge>
        <Badge tone="warning">{issues.bySeverity.medium} medium</Badge>
        <Badge>{issues.bySeverity.low} low</Badge>
      </div>
      <BarList
        rows={Object.entries(issues.byType).map(([type, value]) => ({
          label: ISSUE_NAMES[type] ?? type,
          value,
          tone: type === "orphan" || type === "deep-page" ? "danger" : "warning",
        }))}
      />
    </>
  );
}

export function OrphansByChannel({ discovery }: { discovery: NonNullable<Summary["discovery"]> }) {
  const rows = CHANNELS.filter((c) => c !== "link_graph").map((c) => ({
    label: CHANNEL_NAMES[c] ?? c,
    value: discovery.channels[c]?.orphans ?? 0,
    tone: "danger" as const,
  }));
  return discovery.orphans === 0 ? (
    <EmptyState title="No orphans">Every page the channels list is reachable by links.</EmptyState>
  ) : (
    <>
      <p className="field-hint" style={{ marginTop: 0 }}>
        {discovery.orphans} of {discovery.inventory} known pages are not reachable by links. A page
        found by several channels counts under each.
      </p>
      <BarList rows={rows} />
    </>
  );
}

function TopFixes({ id, sigma }: { id: number; sigma: SigmaVariant }) {
  const fixes = useFixes(id, sigma, 10, "global");
  if (fixes.isPending) return <Spinner />;
  const top = (fixes.data?.fixes ?? []).slice(0, 5);
  if (fixes.error || top.length === 0) return <EmptyState title="No fixes ranked yet" />;
  return <FixTable fixes={top} />;
}

export function SummaryTab() {
  const audit = useCurrentAudit();
  const summary = useSummary(audit.id);
  return (
    <QueryView query={summary}>
      {(s) => (
        <div className="grid">
          <div className="stats">
            <StatCard label="Pages crawled" value={fmtInt(s.pages)} />
            <StatCard
              label="Graph nodes"
              value={s.graph ? fmtInt(s.graph.nodes) : "—"}
              hint={s.graph ? `${fmtInt(s.graph.edges)} links` : undefined}
            />
            <StatCard
              label="Issues"
              value={s.issues ? fmtInt(s.issues.total) : "—"}
              hint={s.issues ? `on ${s.issues.nodesWithIssues} pages` : undefined}
            />
            <StatCard label="Orphans" value={s.discovery ? fmtInt(s.discovery.orphans) : "—"} />
            <StatCard label="Fixes ranked" value={s.fixes ? fmtInt(s.fixes.total) : "—"} />
            <StatCard label="Run time" value={fmtMs(s.durationMs) || "—"} />
          </div>
          <div className="grid grid-2">
            <Card title="Issues">
              {s.issues ? <IssueCounts issues={s.issues} /> : <EmptyState title="Not ready yet" />}
            </Card>
            <Card title="Orphans by channel">
              {s.discovery ? (
                <OrphansByChannel discovery={s.discovery} />
              ) : (
                <EmptyState title="Not ready yet" />
              )}
            </Card>
          </div>
          <Card title="Top 5 fixes">
            {s.fixes ? (
              <TopFixes id={audit.id} sigma={s.fixes.sigma} />
            ) : (
              <EmptyState title="Not ready yet" />
            )}
          </Card>
        </div>
      )}
    </QueryView>
  );
}
