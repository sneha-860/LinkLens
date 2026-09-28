import { Fragment, useMemo, useState } from "react";
import type { AnchorSuggestion, Fix, LearnedFix } from "../../api/types.js";
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

const NO_ANCHOR: Record<Extract<AnchorSuggestion, { status: "none" }>["reason"], string> = {
  "no-paragraphs": "The donor has no paragraph to place the link in",
  "no-title-terms": "The target's title has no distinctive term to match",
  "not-above-epsilon": "No paragraph of the donor is about the target's title",
};

/**
 * Where the link goes: the donor paragraph with the suggested anchor marked, or why not. With
 * `blind` (the rating page) no score is shown.
 */
export function AnchorBlock({
  anchor,
  blind = false,
}: {
  anchor: AnchorSuggestion;
  blind?: boolean;
}) {
  if (anchor.status === "none") {
    return (
      <p className="anchor-none">
        {NO_ANCHOR[anchor.reason]}
        {!blind &&
          anchor.bestRef !== null &&
          ` (best: paragraph ${(anchor.bestParagraphIndex ?? 0) + 1} of ${anchor.paragraphs}, REF ${fmt2(anchor.bestRef)})`}
        : write a sentence that introduces it.
      </p>
    );
  }
  const { text, anchorStart, anchorEnd } = anchor.excerpt;
  return (
    <figure className="anchor-suggestion">
      <figcaption>
        Suggested anchor <strong className="anchor-text">{anchor.anchor}</strong>
        <span className="anchor-meta">
          paragraph {anchor.paragraphIndex + 1} of {anchor.paragraphs}
          {!blind && ` · REF to the title ${fmt2(anchor.ref)}`}
        </span>
      </figcaption>
      <blockquote className="anchor-excerpt">
        {text.slice(0, anchorStart)}
        <mark>{text.slice(anchorStart, anchorEnd)}</mark>
        {text.slice(anchorEnd)}
      </blockquote>
    </figure>
  );
}

/** Readable names of the L13 model's features (analysis/ml; packages/eval/src/l13/features.ts). */
export const FEATURE_NAMES: Record<string, string> = {
  delta_pr: "ΔPR of the target",
  depth_gain: "depth gain",
  newly_reachable: "target becomes reachable",
  ref: "REF",
  cosine: "cosine",
  jaccard: "term Jaccard",
  omega_existing: "prominence of the existing link",
  kappa: "editing effort κ",
  template_reach: "template reach",
  donor_pagerank: "donor PageRank",
  target_pagerank: "target PageRank",
  donor_depth: "donor depth",
  target_depth: "target depth",
  donor_in: "donor in-links",
  donor_out: "donor out-links",
  target_in: "target in-links",
  target_out: "target out-links",
  donor_in_scc: "donor in largest SCC",
  target_in_scc: "target in largest SCC",
  donor_importance: "donor importance",
  target_importance: "target importance",
  same_section: "same section",
  donor_type: "donor page type",
  target_type: "target page type",
};

const featureValue = (v: number | string | null) =>
  v === null
    ? "n/a"
    : typeof v === "string"
      ? v
      : Math.abs(v) < 0.01 && v !== 0
        ? fmtSci(v)
        : fmt2(v);

/** The L13 model's view of a fix: its priority and the features that moved it most (TreeSHAP). */
export function ModelView({ learned }: { learned: LearnedFix }) {
  return (
    <section className="model-view" aria-label="Model view (learned)">
      <h4>
        Model view (learned) <Badge>priority {(100 * learned.priority).toFixed(0)}%</Badge>
      </h4>
      <ul className="shap-list">
        {learned.shap.map((c) => (
          <li key={c.feature}>
            <span className={c.contribution >= 0 ? "shap-up" : "shap-down"}>
              {c.contribution >= 0 ? "▲ +" : "▼ −"}
              {fmt2(Math.abs(c.contribution))}
            </span>{" "}
            {FEATURE_NAMES[c.feature] ?? c.feature} = {featureValue(c.value)}
          </li>
        ))}
      </ul>
      <p className="field-hint">
        SHAP contributions to the model&apos;s score. The rule-based lines above are the explanation
        of record.
      </p>
    </section>
  );
}

/**
 * The explanation of a fix as a card: where the link goes (the anchor block), the other lines,
 * then the numbers behind them.
 */
export function ExplanationCard({ fix }: { fix: Fix }) {
  const anchor = fix.explanation?.anchor ?? null;
  // The anchor block shows the "Where" line's content, so the list leaves it out.
  const lines = (fix.explanation?.lines ?? []).filter(
    (l) => anchor === null || !l.startsWith("Where:"),
  );
  return (
    <div className="explain-card">
      {anchor !== null && <AnchorBlock anchor={anchor} />}
      {fix.explanation ? (
        <ul className="explanation">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">No explanation stored for this fix.</p>
      )}
      {fix.learned && <ModelView learned={fix.learned} />}
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
