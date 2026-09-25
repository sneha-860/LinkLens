import { useMemo, useState } from "react";
import { useDiagnosis } from "../../api/queries.js";
import { CASES, type DiagnosisCase, type DiagnosisItem } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { CASE_NAMES, fmt2 } from "../../ui/format.js";
import { Badge, Button, Card, EmptyState, QueryView, type Tone } from "../../ui/ui.js";
import { Pair } from "../fixes/FixRow.js";
import { CASE_COLOURS, Scatter } from "./Scatter.js";

const TONES: Record<DiagnosisCase, Tone> = {
  v4: "danger",
  v3: "warning",
  v1: "warning",
  v2: "success",
};
const CASE_HELP: Record<DiagnosisCase, string> = {
  v4: "related, but no link",
  v3: "related, link barely visible",
  v1: "prominent link, pages unrelated",
  v2: "related and well linked",
};
const PAGE = 100;

function Table({ rows }: { rows: DiagnosisItem[] }) {
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const [shown, setShown] = useState(PAGE);
  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          (dir === "desc" ? b.severity - a.severity : a.severity - b.severity) ||
          (a.id < b.id ? -1 : 1),
      ),
    [rows, dir],
  );
  if (rows.length === 0) return <EmptyState title="Nothing in this case" />;
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>Pair (source → target)</th>
            <th className="num">REF</th>
            <th className="num">ρ</th>
            <th className="num">ω</th>
            <th className="num" aria-sort={dir === "desc" ? "descending" : "ascending"}>
              <button
                type="button"
                className="sort-button"
                onClick={() => setDir((d) => (d === "desc" ? "asc" : "desc"))}
              >
                Severity {dir === "desc" ? "↓" : "↑"}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, shown).map((x) => (
            <tr key={x.id}>
              <td>
                <Badge tone={TONES[x.case]}>{x.case}</Badge>
              </td>
              <td>
                <Pair from={x.source} to={x.target} />
                {x.explanation && <div className="field-hint">{x.explanation}</div>}
              </td>
              <td className="num">{fmt2(x.ref)}</td>
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
  );
}

export function DiagnosisTab() {
  const audit = useCurrentAudit();
  const diagnosis = useDiagnosis(audit.id);
  const [only, setOnly] = useState<DiagnosisCase | "all">("all");
  const [x, setX] = useState<"rho" | "ref">("rho");

  return (
    <QueryView query={diagnosis}>
      {(d) => {
        const rows = d.diagnoses.filter((i) => only === "all" || i.case === only);
        return (
          <div className="grid">
            <div className="stats" role="group" aria-label="Cases">
              {CASES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`stat stat-button${only === c ? " stat-active" : ""}`}
                  aria-pressed={only === c}
                  onClick={() => setOnly((o) => (o === c ? "all" : c))}
                  style={{ borderTopColor: CASE_COLOURS[c] }}
                >
                  <div className="stat-value">{d.counts[c]}</div>
                  <div className="stat-label">
                    {c} {CASE_NAMES[c]}
                  </div>
                  <div className="stat-hint">{CASE_HELP[c]}</div>
                </button>
              ))}
            </div>
            <Card
              title="Semantic weight against link prominence"
              actions={
                <div className="segmented" role="group" aria-label="x axis">
                  <button type="button" aria-pressed={x === "rho"} onClick={() => setX("rho")}>
                    ρ (normalised REF)
                  </button>
                  <button type="button" aria-pressed={x === "ref"} onClick={() => setX("ref")}>
                    REF
                  </button>
                </div>
              }
            >
              <Scatter items={rows} x={x} alpha={d.alpha} epsilon={d.epsilon} />
              <p className="field-hint">
                The cases are defined on ρ and ω with α = {d.alpha}: right of the line is related;
                above it, prominently linked. {d.counts.unclassified} pairs are in none of the four
                cases.
              </p>
            </Card>
            <Card
              title={
                only === "all"
                  ? `All diagnosed pairs (${rows.length})`
                  : `${only} ${CASE_NAMES[only]} (${rows.length})`
              }
              actions={
                <select
                  aria-label="Case"
                  value={only}
                  onChange={(e) => setOnly(e.target.value as DiagnosisCase | "all")}
                >
                  <option value="all">All cases</option>
                  {CASES.map((c) => (
                    <option key={c} value={c}>
                      {c} {CASE_NAMES[c]}
                    </option>
                  ))}
                </select>
              }
            >
              <Table key={only} rows={rows} />
            </Card>
          </div>
        );
      }}
    </QueryView>
  );
}
