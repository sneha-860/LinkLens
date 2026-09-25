import { Outlet, useOutletContext, useParams } from "react-router";
import { useAudit } from "../api/queries.js";
import type { Audit } from "../api/types.js";
import { useAuditEvents } from "../api/useAuditEvents.js";
import { ProgressPanel } from "../features/progress/ProgressPanel.js";
import { PageHeader } from "../layout/AppShell.js";
import { fmtDate } from "../ui/format.js";
import { ErrorState, Spinner, Tabs } from "../ui/ui.js";

export const TABS = [
  { to: "summary", label: "Summary" },
  { to: "graph", label: "Graph" },
  { to: "fixes", label: "Fixes" },
  { to: "diagnosis", label: "Diagnosis" },
  { to: "orphans", label: "Orphans" },
  { to: "canonicalisation", label: "Canonicalisation" },
  { to: "export", label: "Export" },
];

/** The audit shown by the page, for its tabs. */
export const useCurrentAudit = () => useOutletContext<{ audit: Audit }>().audit;

export function AuditPage() {
  const id = Number(useParams()["id"]);
  const audit = useAudit(id);
  const live = useAuditEvents(audit.data);
  if (audit.isPending) return <Spinner label="Loading the audit" />;
  if (audit.error) return <ErrorState error={audit.error} />;
  const a = audit.data;
  const finished = !a.active && (a.status === "completed" || a.status === "failed");
  return (
    <>
      <PageHeader
        title={a.url}
        sub={`Audit #${a.id} · policy ${a.policy} · started ${fmtDate(a.createdAt)}`}
      />
      {(!finished || a.status === "failed") && <ProgressPanel audit={a} live={live} />}
      <Tabs tabs={TABS} />
      <Outlet context={{ audit: a }} />
    </>
  );
}
