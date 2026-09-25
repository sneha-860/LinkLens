import { useState } from "react";
import { useRankPolicies, useSensitivity } from "../../api/queries.js";
import type { SensitivityRow } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { fmt2, fmtInt, SIGMA_NAMES } from "../../ui/format.js";
import { Badge, BarList, Button, Card, EmptyState, QueryView, Spinner } from "../../ui/ui.js";

const POLICY_TEXT: Record<string, string> = {
  P0: "RFC 3986 normalisation",
  P1: "+ no fragment, no trailing slash",
  P2: "+ no tracking parameters",
  P3: "+ no query, http/https and www. merged",
  P4: "+ redirects followed",
  P5: "+ rel=canonical followed",
};

const signed = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(2)}`);
const opt2 = (x: number | null) => (x === null ? "—" : fmt2(x));

/** The six canonicalisation policies on this run, against the audit's own (E1 sensitivity). */
export function CanonTab() {
  const audit = useCurrentAudit();
  const [k, setK] = useState<10 | 25 | 50>(10);
  const done = audit.status === "completed" && !audit.active;
  const sensitivity = useSensitivity(audit.id, k, audit.crawl.status === "completed");
  const rank = useRankPolicies(audit.id);

  if (audit.crawl.status !== "completed") {
    return (
      <Card>
        <EmptyState title="Not ready yet">The comparison needs the finished crawl.</EmptyState>
      </Card>
    );
  }
  return (
    <QueryView query={sensitivity}>
      {(s) => {
        const missing = s.policies.filter((p) => p.topFixesJaccard === null).length;
        const job = s.fixesJob;
        return (
          <div className="grid">
            <Card
              title="Sensitivity to the canonicalisation policy"
              actions={
                <select
                  aria-label="Top k fixes"
                  value={k}
                  onChange={(e) => setK(Number(e.target.value) as 10 | 25 | 50)}
                >
                  {[10, 25, 50].map((n) => (
                    <option key={n} value={n}>
                      Jaccard of top {n} fixes
                    </option>
                  ))}
                </select>
              }
            >
              <p className="field-hint" style={{ marginTop: 0 }}>
                Each policy merges more URL variants into one page. Every row is compared with{" "}
                {s.baselinePolicy}, this audit's policy, with pages matched in P3 form. Fixes are
                ranked with “{SIGMA_NAMES[s.sigma]}”.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Policy</th>
                      <th className="num">Pages</th>
                      <th className="num">Orphans</th>
                      <th className="num">Jaccard top-{s.k} fixes</th>
                      <th className="num">Spearman PageRank</th>
                      <th className="num">Mean depth shift</th>
                      <th className="num">Mean |shift|</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.policies.map((p: SensitivityRow) => (
                      <tr key={p.policy}>
                        <td>
                          <strong>{p.policy}</strong>{" "}
                          {p.policy === s.baselinePolicy && <Badge tone="info">this audit</Badge>}
                          <div className="field-hint">{POLICY_TEXT[p.policy]}</div>
                        </td>
                        <td className="num">{fmtInt(p.nodes)}</td>
                        <td className="num">{fmtInt(p.orphans)}</td>
                        <td className="num">
                          {p.topFixesJaccard === null ? (
                            <span className="field-hint">not ranked</span>
                          ) : (
                            fmt2(p.topFixesJaccard)
                          )}
                        </td>
                        <td className="num">{opt2(p.pagerankSpearman)}</td>
                        <td className="num">{signed(p.meanDepthShift)}</td>
                        <td className="num">{opt2(p.meanAbsDepthShift)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {job?.status === "running" ? (
                <div className="row" style={{ marginTop: 12 }} role="status">
                  <Spinner
                    label={`Ranking fixes under ${job.current ?? "the next policy"} (${job.done.length} of 6 done)`}
                  />
                </div>
              ) : missing > 0 ? (
                <div className="row" style={{ marginTop: 12 }}>
                  <Button onClick={() => rank.mutate()} disabled={!done || rank.isPending}>
                    Rank fixes under all policies
                  </Button>
                  <span className="field-hint">
                    Runs the ranking stages for the {missing} other{" "}
                    {missing === 1 ? "policy" : "policies"} in the background (seconds to minutes
                    each).
                  </span>
                </div>
              ) : null}
              {job?.status === "failed" && (
                <div className="error" role="alert" style={{ marginTop: 12 }}>
                  Ranking under another policy failed: {job.error}
                </div>
              )}
            </Card>
            <div className="grid grid-2">
              <Card title="Pages per policy">
                <BarList
                  rows={s.policies.map((p) => ({ label: p.policy, value: p.nodes }))}
                  format={fmtInt}
                />
              </Card>
              <Card title="Orphans per policy">
                <BarList
                  rows={s.policies.map((p) => ({
                    label: p.policy,
                    value: p.orphans,
                    tone: "danger" as const,
                  }))}
                  format={fmtInt}
                />
              </Card>
            </div>
          </div>
        );
      }}
    </QueryView>
  );
}
