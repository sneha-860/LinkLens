import { useState } from "react";
import { useDiagnosis } from "../../api/queries.js";
import { CASES, type DiagnosisCase } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { CASE_NAMES, fmt2 } from "../../ui/format.js";
import { Badge, Button, Card, EmptyState, QueryView, type Tone } from "../../ui/ui.js";
import { Pair } from "../fixes/FixRow.js";

const TONES: Record<DiagnosisCase, Tone> = {
  v4: "danger",
  v3: "warning",
  v1: "warning",
  v2: "success",
};
const PAGE = 100;

export function DiagnosisTab() {
  const audit = useCurrentAudit();
  const diagnosis = useDiagnosis(audit.id);
  const [only, setOnly] = useState<DiagnosisCase | "all">("v4");
  const [shown, setShown] = useState(PAGE);

  return (
    <QueryView query={diagnosis}>
      {(d) => {
        const rows = d.diagnoses.filter((x) => only === "all" || x.case === only);
        return (
          <Card
            title="Diagnosis"
            actions={
              <div className="row" role="group" aria-label="Case">
                {(["all", ...CASES] as const).map((c) => (
                  <Button
                    key={c}
                    variant={only === c ? "primary" : "secondary"}
                    onClick={() => {
                      setOnly(c);
                      setShown(PAGE);
                    }}
                  >
                    {c === "all"
                      ? `All (${d.diagnoses.length})`
                      : `${c} ${CASE_NAMES[c]} (${d.counts[c]})`}
                  </Button>
                ))}
              </div>
            }
          >
            <p className="field-hint" style={{ marginTop: 0 }}>
              ρ: how much of the target's topic the source covers (normalised per source). ω: how
              prominent the existing link is. Threshold α = {d.alpha}.
            </p>
            {rows.length === 0 ? (
              <EmptyState title="Nothing in this case" />
            ) : (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>Case</th>
                      <th>Pair (source → target)</th>
                      <th className="num">ρ</th>
                      <th className="num">ω</th>
                      <th className="num">Severity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, shown).map((x) => (
                      <tr key={x.id}>
                        <td>
                          <Badge tone={TONES[x.case]}>{x.case}</Badge>
                        </td>
                        <td>
                          <Pair from={x.source} to={x.target} />
                          {x.explanation && <div className="field-hint">{x.explanation}</div>}
                        </td>
                        <td className="num">{fmt2(x.rho)}</td>
                        <td className="num">{fmt2(x.omega)}</td>
                        <td className="num">{fmt2(x.severity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > shown && (
                  <div className="row" style={{ marginTop: 12 }}>
                    <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
                      Show more ({rows.length - shown} left)
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
        );
      }}
    </QueryView>
  );
}
