import { Link, useNavigate } from "react-router";
import { useAudits } from "../api/queries.js";
import { PageHeader } from "../layout/AppShell.js";
import { fmtDate, STAGE_NAMES } from "../ui/format.js";
import { Card, EmptyState, QueryView, StatusBadge } from "../ui/ui.js";

export function AuditsPage() {
  const audits = useAudits();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Audits"
        actions={
          <Link to="/audits/new" className="btn btn-primary">
            New audit
          </Link>
        }
      />
      <Card>
        <QueryView query={audits}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No audits yet">
                <Link to="/audits/new">Start your first audit</Link>
              </EmptyState>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Policy</th>
                    <th>Status</th>
                    <th>Stage</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((a) => (
                    <tr
                      key={a.id}
                      className="clickable"
                      onClick={() => void navigate(`/audits/${a.id}`)}
                    >
                      <td>
                        <Link to={`/audits/${a.id}`} onClick={(e) => e.stopPropagation()}>
                          {a.url}
                        </Link>
                      </td>
                      <td>{a.policy}</td>
                      <td>
                        <StatusBadge status={a.status} />
                      </td>
                      <td>
                        {a.currentStage === null
                          ? ""
                          : (STAGE_NAMES[a.currentStage] ?? a.currentStage)}
                      </td>
                      <td>{fmtDate(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </QueryView>
      </Card>
    </>
  );
}
