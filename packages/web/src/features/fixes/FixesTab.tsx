import { useState } from "react";
import { useFixes } from "../../api/queries.js";
import { SIGMA_VARIANTS, type FixScoringMode, type SigmaVariant } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { SIGMA_NAMES } from "../../ui/format.js";
import { Card, EmptyState, QueryView } from "../../ui/ui.js";
import { FixTable } from "./FixRow.js";

export function FixesTab() {
  const audit = useCurrentAudit();
  const [sigma, setSigma] = useState<SigmaVariant>(
    (audit.options["sigma"] as SigmaVariant | undefined) ?? "refGateCosine",
  );
  const [k, setK] = useState<10 | 25 | 50>(25);
  const [scoring, setScoring] = useState<FixScoringMode>("formula");
  const fixes = useFixes(audit.id, sigma, k, "global", true, scoring);

  return (
    <Card
      title="Ranked fixes"
      actions={
        <div className="row">
          <select
            aria-label="Scoring"
            value={scoring}
            onChange={(e) => setScoring(e.target.value as FixScoringMode)}
          >
            <option value="formula">Score S (rule)</option>
            <option value="learned">Learned (L13 model)</option>
          </select>
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
        </div>
      }
    >
      <p className="field-hint" style={{ marginTop: 0 }}>
        {scoring === "formula" ? (
          <>
            Score S = ΔPR × σ / κ: the PageRank a link adds to its target, times how related the
            pages are, divided by the editing effort.
          </>
        ) : (
          <>
            Learned priority (0–1): a LightGBM ranker trained on other sites to recover hidden
            editorial links. It is experimental; S stays the default.
          </>
        )}{" "}
        The top {k} by score are fetched; sort them by any column, and click a row for its
        explanation.
      </p>
      <QueryView query={fixes}>
        {(r) =>
          r.total === 0 || (r.fixes ?? []).length === 0 ? (
            <EmptyState title="No fixes">
              No page needs a link that a related page could give.
            </EmptyState>
          ) : (
            <>
              <FixTable fixes={r.fixes ?? []} sortable />
              <p className="field-hint">
                Showing {(r.fixes ?? []).length} of {r.total} fixes ranked with “
                {SIGMA_NAMES[r.sigma]}”
                {r.scoring === "learned" && r.learnedModel
                  ? `, by the learned priority of a model trained on ${r.learnedModel.trainedOn.join(", ")} (never this site)`
                  : ""}
                .
              </p>
            </>
          )
        }
      </QueryView>
    </Card>
  );
}
