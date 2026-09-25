import { Fragment, useMemo, useState } from "react";
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
    ? `${f.deltaPr >= 0 ? "+" : ""}${((100 * f.deltaPr) / f.prBefore).toFixed(1)}%`
    : "";

export type SortKey = "score" | "deltaPr" | "deltaDepth" | "sigma" | "kappa" | "type";
const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "type", label: "Type", numeric: false },
  { key: "deltaPr", label: "ΔPR", numeric: true },
  { key: "deltaDepth", label: "Δdepth", numeric: true },
  { key: "sigma", label: "σ", numeric: true },
  { key: "kappa", label: "κ", numeric: true },
  { key: "score", label: "Score", numeric: true },
];

/** Sort value: Δdepth without a value (unreachable → reachable) sorts as the biggest gain. */
const value = (f: Fix, k: SortKey): number | string =>
  k === "type" ? f.type : k === "deltaDepth" ? (f.deltaDepth ?? -Infinity) : f[k];

export function sortFixes(fixes: readonly Fix[], key: SortKey, dir: "asc" | "desc"): Fix[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...fixes].sort((a, b) => {
    const x = value(a, key);
    const y = value(b, key);
    const c =
      typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sign * c || a.rank - b.rank;
  });
}

/** The explanation of a fix as a card: its lines, then the numbers behind them. */
export function ExplanationCard({ fix }: { fix: Fix }) {
  return (
    <div className="explain-card">
      {fix.explanation ? (
        <ul className="explanation">
          {fix.explanation.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">No explanation stored for this fix.</p>
      )}
      <dl className="props props-inline">
        <dt>REF</dt>
        <dd>{fmt2(fix.ref)}</dd>
        <dt>cosine</dt>
        <dd>{fix.cosine === null ? "—" : fmt2(fix.cosine)}</dd>
        <dt>PR before → after</dt>
        <dd>
          {fmtSci(fix.prBefore)} → {fmtSci(fix.prAfter)}
        </dd>
        <dt>depth</dt>
        <dd>
          {fix.depthBefore ?? "unreachable"} → {fix.depthAfter ?? "unreachable"}
        </dd>
        <dt>template reach</dt>
        <dd>
          {fix.templateReach} page{fix.templateReach === 1 ? "" : "s"}
        </dd>
        <dt>σ variants</dt>
        <dd>
          {Object.entries(fix.sigmas)
            .map(([k, v]) => `${k} ${fmt2(v)}`)
            .join(" · ")}
        </dd>
      </dl>
    </div>
  );
}

/** Fixes as a table; with `sortable`, the headers sort. Click a row for its explanation card. */
export function FixTable({
  fixes,
  rankBy = "rank",
  sortable = false,
}: {
  fixes: Fix[];
  rankBy?: "rank" | "targetRank";
  sortable?: boolean;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "score",
    dir: "desc",
  });
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(
    () => (sortable ? sortFixes(fixes, sort.key, sort.dir) : fixes),
    [fixes, sortable, sort],
  );
  const header = (c: (typeof COLUMNS)[number]) => {
    const active = sortable && sort.key === c.key;
    const label = `${c.label}${active ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}`;
    return (
      <th
        key={c.key}
        className={c.numeric ? "num" : undefined}
        aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : undefined}
      >
        {sortable ? (
          <button
            type="button"
            className="sort-button"
            onClick={() =>
              setSort((s) =>
                s.key === c.key
                  ? { key: c.key, dir: s.dir === "desc" ? "asc" : "desc" }
                  : { key: c.key, dir: c.numeric ? "desc" : "asc" },
              )
            }
          >
            {label}
          </button>
        ) : (
          label
        )}
      </th>
    );
  };
  return (
    <table>
      <thead>
        <tr>
          <th className="num">#</th>
          <th>Link (donor → target)</th>
          {COLUMNS.map(header)}
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => (
          <Fragment key={f.id}>
            <tr
              className="clickable"
              onClick={() => setOpen((o) => (o === f.id ? null : f.id))}
              aria-expanded={open === f.id}
            >
              <td className="num">{f[rankBy]}</td>
              <td>
                <Pair from={f.donor} to={f.target} />
                {f.explanation && <div className="field-hint">{f.explanation.sentence}</div>}
              </td>
              <td>
                <Badge tone={f.type === "add-link" ? "info" : "warning"}>
                  {f.type === "add-link" ? "add link" : "make visible"}
                </Badge>
                {f.diagnosis !== null && (
                  <>
                    {" "}
                    <Badge>{f.diagnosis}</Badge>
                  </>
                )}
              </td>
              <td className="num">
                {fmtSci(f.deltaPr, true)}
                <div className="field-hint">{pct(f)}</div>
              </td>
              <td className="num">{f.deltaDepth ?? "—"}</td>
              <td className="num">{fmt2(f.sigma)}</td>
              <td className="num">{f.kappa}</td>
              <td className="num">{fmtSci(f.score)}</td>
            </tr>
            {open === f.id && (
              <tr className="explain-row">
                <td />
                <td colSpan={7}>
                  <ExplanationCard fix={f} />
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
