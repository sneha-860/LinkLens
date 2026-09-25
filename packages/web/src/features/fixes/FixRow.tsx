import { useState } from "react";
import type { Fix } from "../../api/types.js";
import { fmt2, fmtSci, shortUrl } from "../../ui/format.js";
import { Badge } from "../../ui/ui.js";

export function Pair({ from, to }: { from: string; to: string }) {
  return (
    <span className="pair" title={`${from} → ${to}`}>
      {shortUrl(from)}
      <span className="pair-arrow">→</span>
      {shortUrl(to)}
    </span>
  );
}

const pct = (f: Fix) =>
  f.prBefore > 0
    ? ` (${f.deltaPr >= 0 ? "+" : ""}${((100 * f.deltaPr) / f.prBefore).toFixed(1)}%)`
    : "";

/** One fix: the pair, its type and numbers; click to show the explanation. */
export function FixRow({ fix, rankLabel }: { fix: Fix; rankLabel?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="clickable" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <td className="num">{rankLabel ?? fix.rank}</td>
        <td>
          <Pair from={fix.donor} to={fix.target} />
          {fix.explanation && <div className="field-hint">{fix.explanation.sentence}</div>}
        </td>
        <td>
          <Badge tone={fix.type === "add-link" ? "info" : "warning"}>
            {fix.type === "add-link" ? "add link" : "make visible"}
          </Badge>
          {fix.diagnosis !== null && (
            <>
              {" "}
              <Badge>{fix.diagnosis}</Badge>
            </>
          )}
        </td>
        <td className="num">
          {fmtSci(fix.deltaPr, true)}
          <div className="field-hint">{pct(fix)}</div>
        </td>
        <td className="num">{fix.deltaDepth === null ? "—" : fix.deltaDepth}</td>
        <td className="num">{fmt2(fix.sigma)}</td>
        <td className="num">{fix.kappa}</td>
        <td className="num">{fmtSci(fix.score)}</td>
      </tr>
      {open && fix.explanation && (
        <tr>
          <td />
          <td colSpan={7}>
            <ul className="explanation">
              {fix.explanation.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

export function FixTable({
  fixes,
  rankBy = "rank",
}: {
  fixes: Fix[];
  rankBy?: "rank" | "targetRank";
}) {
  return (
    <table>
      <thead>
        <tr>
          <th className="num">#</th>
          <th>Link (donor → target)</th>
          <th>Type</th>
          <th className="num">ΔPR</th>
          <th className="num">Δdepth</th>
          <th className="num">σ</th>
          <th className="num">κ</th>
          <th className="num">Score</th>
        </tr>
      </thead>
      <tbody>
        {fixes.map((f) => (
          <FixRow key={f.id} fix={f} rankLabel={f[rankBy]} />
        ))}
      </tbody>
    </table>
  );
}
