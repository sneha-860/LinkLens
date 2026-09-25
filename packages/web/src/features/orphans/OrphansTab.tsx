import { useState } from "react";
import { useOrphans, useReconciliation } from "../../api/queries.js";
import { CHANNELS, type Orphan } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { CHANNEL_NAMES, fmt2, fmtInt, fmtSci, shortUrl } from "../../ui/format.js";
import { Badge, Button, Card, EmptyState, QueryView } from "../../ui/ui.js";

const PAGE = 100;
const STATUS_TEXT: Record<Orphan["status"], string> = {
  scored: "No reachable page covers its topic.",
  "no-page": "Its page could not be fetched.",
  "no-text": "Its page has no text to match.",
};

/** Every known URL × the six discovery channels, orphans first, with each channel's yield. */
function ReconciliationTable() {
  const audit = useCurrentAudit();
  const rec = useReconciliation(audit.id);
  const [orphansOnly, setOrphansOnly] = useState(true);
  const [shown, setShown] = useState(PAGE);
  return (
    <QueryView query={rec}>
      {(r) => {
        const rows = orphansOnly ? r.inventory.filter((e) => e.orphan) : r.inventory;
        return (
          <Card
            title="Reconciliation"
            actions={
              <div className="segmented" role="group" aria-label="Rows">
                <button
                  type="button"
                  aria-pressed={orphansOnly}
                  onClick={() => setOrphansOnly(true)}
                >
                  Orphans ({r.orphans})
                </button>
                <button
                  type="button"
                  aria-pressed={!orphansOnly}
                  onClick={() => setOrphansOnly(false)}
                >
                  All URLs ({r.inventory.length})
                </button>
              </div>
            }
          >
            <div className="table-scroll">
              <table className="reconciliation">
                <thead>
                  <tr>
                    <th>URL</th>
                    {CHANNELS.map((c) => (
                      <th key={c} className="tick">
                        {CHANNEL_NAMES[c]}
                      </th>
                    ))}
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, shown).map((e) => (
                    <tr key={e.node}>
                      <td className="pair" title={e.node}>
                        {shortUrl(e.node)}
                      </td>
                      {CHANNELS.map((c) => (
                        <td
                          key={c}
                          className="tick"
                          aria-label={
                            e.channels.includes(c) ? `found by ${CHANNEL_NAMES[c]}` : undefined
                          }
                        >
                          {e.channels.includes(c) ? "✓" : ""}
                        </td>
                      ))}
                      <td>
                        {e.orphan ? (
                          <Badge tone="danger">orphan</Badge>
                        ) : e.reachable ? (
                          <span className="field-hint">depth {e.depth}</span>
                        ) : (
                          <Badge>unreachable</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {(
                    [
                      ["URLs found", "total"],
                      ["Found only here (marginal yield)", "exclusive"],
                      ["Orphans found", "orphans"],
                    ] as const
                  ).map(([label, key]) => (
                    <tr key={key}>
                      <th>{label}</th>
                      {CHANNELS.map((c) => (
                        <td key={c} className="tick num">
                          {fmtInt(r.channels[c]?.[key] ?? 0)}
                        </td>
                      ))}
                      <td />
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
            {rows.length > shown && (
              <div className="row" style={{ marginTop: 12 }}>
                <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
                  Show more ({rows.length - shown} left)
                </Button>
              </div>
            )}
          </Card>
        );
      }}
    </QueryView>
  );
}

function OrphanCard({ orphan }: { orphan: Orphan }) {
  return (
    <Card
      title={<span className="pair">{shortUrl(orphan.node)}</span>}
      actions={
        <div className="row">
          {orphan.revealedBy.map((c) => (
            <Badge key={c} tone="info">
              {CHANNEL_NAMES[c] ?? c}
            </Badge>
          ))}
        </div>
      }
    >
      {orphan.donors.length === 0 ? (
        <p className="field-hint">No rescue donor. {STATUS_TEXT[orphan.status]}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Donor (link from)</th>
              <th className="num">REF</th>
              <th className="num">ΔPR</th>
              <th className="num">Depth after</th>
            </tr>
          </thead>
          <tbody>
            {orphan.donors.map((d) => (
              <tr key={d.donor}>
                <td className="num">{d.rank}</td>
                <td>
                  <span className="pair">{shortUrl(d.donor)}</span>
                  {d.explanation && (
                    <ul className="explanation">
                      {d.explanation.lines.slice(1).map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="num">{fmt2(d.ref)}</td>
                <td className="num">{fmtSci(d.deltaPr, true)}</td>
                <td className="num">{d.depthAfter ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function OrphansTab() {
  const audit = useCurrentAudit();
  const orphans = useOrphans(audit.id);
  return (
    <div className="grid">
      <ReconciliationTable />
      <h2 className="section-title">Rescue donors</h2>
      <QueryView query={orphans}>
        {(r) =>
          r.orphans.length === 0 ? (
            <Card>
              <EmptyState title="No orphans">
                Every page the discovery channels list is linked.
              </EmptyState>
            </Card>
          ) : (
            <div className="grid">
              <p className="field-hint" style={{ margin: 0 }}>
                For each orphan, the reachable pages that cover its topic (REF shortlist), ordered
                by the PageRank a link from them would give it.
              </p>
              {r.orphans.map((o) => (
                <OrphanCard key={o.node} orphan={o} />
              ))}
            </div>
          )
        }
      </QueryView>
    </div>
  );
}
