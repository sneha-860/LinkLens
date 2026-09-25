import { useSensitivity } from "../../api/queries.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { fmt2, fmtInt } from "../../ui/format.js";
import { Badge, BarList, Card, EmptyState, QueryView } from "../../ui/ui.js";

const POLICY_TEXT: Record<string, string> = {
  P0: "RFC 3986 normalisation",
  P1: "+ no fragment, no trailing slash",
  P2: "+ no tracking parameters",
  P3: "+ no query, http/https and www. merged",
  P4: "+ redirects followed",
  P5: "+ rel=canonical followed",
};

/** The six canonicalisation policies on this run (E1 sensitivity). */
export function CanonTab() {
  const audit = useCurrentAudit();
  const crawled = audit.crawl.status === "completed";
  const sensitivity = useSensitivity(audit.id, crawled);
  if (!crawled) {
    return (
      <Card>
        <EmptyState title="Not ready yet">The comparison needs the finished crawl.</EmptyState>
      </Card>
    );
  }
  return (
    <QueryView query={sensitivity}>
      {(s) => (
        <div className="grid">
          <Card title="How the policy changes the site">
            <p className="field-hint" style={{ marginTop: 0 }}>
              Each policy merges more URL variants into one page. Top-10 overlap compares the ten
              highest-PageRank pages with those under {s.baselinePolicy}, this audit's policy.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Policy</th>
                  <th className="num">Pages (nodes)</th>
                  <th className="num">Links</th>
                  <th className="num">Reachable</th>
                  <th className="num">Orphans</th>
                  <th className="num">Issues</th>
                  <th className="num">Top-10 overlap</th>
                </tr>
              </thead>
              <tbody>
                {s.policies.map((p) => (
                  <tr key={p.policy}>
                    <td>
                      <strong>{p.policy}</strong>{" "}
                      {p.policy === s.baselinePolicy && <Badge tone="info">this audit</Badge>}
                      <div className="field-hint">{POLICY_TEXT[p.policy]}</div>
                    </td>
                    <td className="num">{fmtInt(p.nodes)}</td>
                    <td className="num">{fmtInt(p.edges)}</td>
                    <td className="num">{fmtInt(p.reachable)}</td>
                    <td className="num">{fmtInt(p.orphans)}</td>
                    <td className="num">{fmtInt(p.issues)}</td>
                    <td className="num">{fmt2(p.top10JaccardVsBaseline)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <div className="grid grid-2">
            <Card title="Pages per policy">
              <BarList
                rows={s.policies.map((p) => ({ label: p.policy, value: p.nodes }))}
                format={fmtInt}
              />
            </Card>
            <Card title="Issues per policy">
              <BarList
                rows={s.policies.map((p) => ({
                  label: p.policy,
                  value: p.issues,
                  tone: "warning" as const,
                }))}
                format={fmtInt}
              />
            </Card>
          </div>
        </div>
      )}
    </QueryView>
  );
}
