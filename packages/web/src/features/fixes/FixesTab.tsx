import { useState } from "react";
import { useFixes } from "../../api/queries.js";
import { SIGMA_VARIANTS, type SigmaVariant } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { shortUrl, SIGMA_NAMES } from "../../ui/format.js";
import { Card, EmptyState, QueryView } from "../../ui/ui.js";
import { FixTable } from "./FixRow.js";

export function FixesTab() {
  const audit = useCurrentAudit();
  const [sigma, setSigma] = useState<SigmaVariant>(
    (audit.options["sigma"] as SigmaVariant | undefined) ?? "refGateCosine",
  );
  const [k, setK] = useState<10 | 25 | 50>(10);
  const [scope, setScope] = useState<"global" | "target">("global");
  const fixes = useFixes(audit.id, sigma, k, scope);

  return (
    <Card
      title="Ranked fixes"
      actions={
        <div className="row">
          <select
            aria-label="σ variant"
            value={sigma}
            onChange={(e) => setSigma(e.target.value as SigmaVariant)}
          >
            {SIGMA_VARIANTS.map((s) => (
              <option key={s} value={s}>
                {SIGMA_NAMES[s]}
              </option>
            ))}
          </select>
          <select
            aria-label="Top k"
            value={k}
            onChange={(e) => setK(Number(e.target.value) as 10 | 25 | 50)}
          >
            {[10, 25, 50].map((n) => (
              <option key={n} value={n}>
                Top {n}
              </option>
            ))}
          </select>
          <select
            aria-label="Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as "global" | "target")}
          >
            <option value="global">Overall</option>
            <option value="target">Per target page</option>
          </select>
        </div>
      }
    >
      <p className="field-hint" style={{ marginTop: 0 }}>
        Score S = ΔPR × σ / κ: the PageRank a link adds to its target, times how related the pages
        are, divided by the editing effort. Click a row for the full explanation.
      </p>
      <QueryView query={fixes}>
        {(r) =>
          r.total === 0 ? (
            <EmptyState title="No fixes">
              No page needs a link that a related page could give.
            </EmptyState>
          ) : r.fixes !== undefined ? (
            <FixTable fixes={r.fixes} />
          ) : (
            <div className="grid">
              {(r.targets ?? []).map((t) => (
                <div key={t.target}>
                  <h3 className="pair" style={{ margin: "8px 0" }}>
                    {shortUrl(t.target)}
                  </h3>
                  <FixTable fixes={t.fixes} rankBy="targetRank" />
                </div>
              ))}
            </div>
          )
        }
      </QueryView>
    </Card>
  );
}
