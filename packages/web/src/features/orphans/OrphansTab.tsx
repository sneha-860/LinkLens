import { useOrphans } from "../../api/queries.js";
import type { Orphan } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { CHANNEL_NAMES, fmt2, fmtSci, shortUrl } from "../../ui/format.js";
import { Badge, Card, EmptyState, QueryView } from "../../ui/ui.js";

const STATUS_TEXT: Record<Orphan["status"], string> = {
  scored: "",
  "no-page": "Its page could not be fetched.",
  "no-text": "Its page has no text to match.",
};

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
        <p className="field-hint">
          No rescue donor. {STATUS_TEXT[orphan.status] || "No reachable page covers its topic."}
        </p>
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
              Pages found by sitemaps, feeds or llms.txt but linked from nowhere. Donors are ranked
              by the PageRank a link from them would give (after a REF shortlist).
            </p>
            {r.orphans.map((o) => (
              <OrphanCard key={o.node} orphan={o} />
            ))}
          </div>
        )
      }
    </QueryView>
  );
}
