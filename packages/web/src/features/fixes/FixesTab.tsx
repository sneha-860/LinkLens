import { useState } from "react";
import { useFixes } from "../../api/queries.js";
import {
  SIGMA_VARIANTS,
  type FixScoringMode,
  type ScoringModelView,
  type SigmaVariant,
} from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { SIGMA_NAMES } from "../../ui/format.js";
import { Card, EmptyState, QueryView } from "../../ui/ui.js";
import { FixTable } from "./FixRow.js";

const SCORING_MODES: readonly FixScoringMode[] = ["formula", "importance", "learned"];

const MODE_NAMES: Record<FixScoringMode, string> = {
  formula: "Score S (formula)",
  importance: "S × importance",
  learned: "Learned (L13 model)",
};

const MODE_HINTS: Record<FixScoringMode, string> = {
  formula:
    "Score S = ΔPR × σ / κ: the PageRank a link adds to its target, times how related the pages are, divided by the editing effort.",
  importance:
    "S × importance: S weighted by how much the target is worth linking to (its page type, PageRank, depth and inbound links; heuristic weights).",
  learned:
    "Learned priority (0–1): a LightGBM ranker trained to recover links hidden from other sites. Its labels are masked links, not editorial judgement; it is experimental and S stays the default.",
};

/** Where the learned priority comes from, in words. */
function modelNote(m: ScoringModelView): string {
  const sites = m.trainedOn.join(", ");
  return m.source === "pipeline"
    ? `by the learned priority of a model fit on ${sites}` +
        (m.seenSite ? " (this site was one of them: its scores are in-sample)" : "")
    : `by the learned priority of a model trained on ${sites} (never this site)`;
}

export function FixesTab() {
  const audit = useCurrentAudit();
  const [sigma, setSigma] = useState<SigmaVariant>(
    (audit.options["sigma"] as SigmaVariant | undefined) ?? "refGateCosine",
  );
  const [k, setK] = useState<10 | 25 | 50>(25);
  const [mode, setMode] = useState<FixScoringMode | undefined>(undefined);
  const fixes = useFixes(audit.id, sigma, k, "global", true, mode);
  // The mode the API used (the run's default until one is picked).
  const shown: FixScoringMode = fixes.data?.mode ?? mode ?? "formula";

  return (
    <Card
      title="Ranked fixes"
      actions={
        <div className="row">
          <select
            aria-label="Scoring mode"
            value={shown}
            onChange={(e) => setMode(e.target.value as FixScoringMode)}
          >
            {SCORING_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_NAMES[m]}
              </option>
            ))}
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
        {MODE_HINTS[shown]} The top {k} by score are fetched; sort them by any column, and click a
        row for its explanation.
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
                {shown === "learned" && r.learnedModel ? `, ${modelNote(r.learnedModel)}` : ""}.
              </p>
            </>
          )
        }
      </QueryView>
    </Card>
  );
}
