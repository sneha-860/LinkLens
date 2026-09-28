import { useState } from "react";
import type { Fix, NodeImportance, PageType } from "../../api/types.js";
import { fmt2, fmtSci, shortUrl } from "../../ui/format.js";
import { Badge, Button, type Tone } from "../../ui/ui.js";
import { REGIONS, type LinkRow, type NodeDetails } from "./model.js";
import type { Preview } from "./CytoscapeView.js";

const SEVERITY: Record<string, Tone> = { high: "danger", medium: "warning", low: "neutral" };
const regionLabel = (r: string) => REGIONS.find((x) => x.region === r)?.label ?? r;
const LIST = 12;

/** The main facts of an issue's evidence, readable. */
function evidence(e: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof e["depth"] === "number")
    parts.push(`depth ${e["depth"]} (> ${String(e["threshold"])})`);
  if (typeof e["pagerank"] === "number")
    parts.push(`PageRank ${fmtSci(e["pagerank"])} (< ${fmtSci(Number(e["threshold"]))})`);
  if (Array.isArray(e["channels"]))
    parts.push(`found via ${(e["channels"] as string[]).join(", ")}`);
  return parts.join("; ");
}

function Links({ title, rows, empty }: { title: string; rows: LinkRow[]; empty: string }) {
  const [all, setAll] = useState(false);
  return (
    <section className="panel-section">
      <h4>
        {title} <span className="field-hint">({rows.length})</span>
      </h4>
      {rows.length === 0 ? (
        <p className="field-hint">{empty}</p>
      ) : (
        <ul className="link-list">
          {(all ? rows : rows.slice(0, LIST)).map((r) => (
            <li key={r.node}>
              <span className="pair" title={r.node}>
                {shortUrl(r.node)}
              </span>{" "}
              <Badge tone={r.region === "body" ? "info" : "neutral"}>{regionLabel(r.region)}</Badge>
              {r.count > 1 && <span className="field-hint"> ×{r.count}</span>}
              {r.anchors.length > 0 && (
                <div className="field-hint">“{r.anchors.slice(0, 2).join("”, “")}”</div>
              )}
            </li>
          ))}
        </ul>
      )}
      {rows.length > LIST && (
        <button type="button" className="link-button" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

const TYPE_LABELS: Record<PageType, string> = {
  homepage: "Homepage",
  hub: "Category / hub",
  product: "Product",
  article: "Article / doc",
  utility: "Utility",
  other: "Other",
};

/** How the page type was decided, in words. */
function ruleText(i: NodeImportance): string {
  if (i.rule === "seed") return "the crawl's seed";
  if (i.rule === "default") return "no rule matched";
  const [kind, what] = i.rule.split(":");
  if (kind === "schema") return `schema.org ${what ?? ""}`;
  if (kind === "url") return `URL pattern ${i.evidence}`;
  return i.evidence;
}

/** Page type (rule-based) and importance with its components (L12; heuristic weights). */
function ImportanceRows({ i }: { i: NodeImportance }) {
  const c = i.components;
  return (
    <>
      <dt>Page type</dt>
      <dd>
        <Badge tone="info">{TYPE_LABELS[i.type]}</Badge>{" "}
        <span className="field-hint">{ruleText(i)}</span>
      </dd>
      <dt>Importance</dt>
      <dd>
        {fmt2(i.importance)}{" "}
        <span className="field-hint">
          type prior {fmt2(c.typePrior)} · PageRank percentile {fmt2(c.pagerank)} · depth{" "}
          {fmt2(c.depth)} · inbound body links {fmt2(c.inboundBodyLinks)} ({i.raw.inboundBodyLinks})
        </span>
      </dd>
    </>
  );
}

export function NodePanel({
  details,
  fixesAvailable,
  preview,
  onPreview,
  onClose,
}: {
  details: NodeDetails;
  /** Fixes exist for this policy (they are computed under the audit's policy only). */
  fixesAvailable: boolean;
  preview: Preview | null;
  onPreview: (p: Preview | null) => void;
  onClose: () => void;
}) {
  const a = details.attributes;
  const isPreviewed = (f: Fix) => preview?.donor === f.donor && preview.target === f.target;
  return (
    <aside className="node-panel" aria-label="Page details">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 className="pair" style={{ wordBreak: "break-all" }}>
          {shortUrl(details.node)}
        </h3>
        <button type="button" className="link-button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <a
        href={details.node}
        target="_blank"
        rel="noreferrer"
        className="field-hint"
        style={{ wordBreak: "break-all" }}
      >
        {details.node}
      </a>

      <section className="panel-section">
        <h4>Metrics</h4>
        {a === null ? (
          <p className="field-hint">Not in the link graph: no crawled page links to it.</p>
        ) : (
          <dl className="props">
            <dt>PageRank</dt>
            <dd>{fmtSci(a.pagerank ?? 0)}</dd>
            <dt>Depth</dt>
            <dd>{a.depth ?? "unreachable"}</dd>
            <dt>Links in / out</dt>
            <dd>
              {a.inDegree ?? 0} / {a.outDegree ?? 0}
            </dd>
            <dt>Betweenness</dt>
            <dd>{fmt2(a.betweennessNormalized ?? 0)}</dd>
            <dt>Crawled</dt>
            <dd>{a.crawled ? "yes" : "no"}</dd>
            {details.importance !== null && <ImportanceRows i={details.importance} />}
          </dl>
        )}
      </section>

      <section className="panel-section">
        <h4>Issues</h4>
        {details.issues.length === 0 ? (
          <p className="field-hint">None.</p>
        ) : (
          <ul className="link-list">
            {details.issues.map((i) => (
              <li key={i.id}>
                <Badge tone={SEVERITY[i.severity] ?? "neutral"}>{i.severity}</Badge>{" "}
                {i.rule ?? i.type}
                {evidence(i.evidence) && <div className="field-hint">{evidence(i.evidence)}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel-section">
        <h4>Fixes for this page</h4>
        {!fixesAvailable ? (
          <p className="field-hint">Fixes are ranked under the audit's policy only.</p>
        ) : details.fixes.length === 0 ? (
          <p className="field-hint">No suggested link to this page.</p>
        ) : (
          <ul className="link-list">
            {details.fixes.map((f) => (
              <li key={f.id}>
                <span className="pair">{shortUrl(f.donor)}</span> → here{" "}
                <Badge tone={f.type === "add-link" ? "info" : "warning"}>
                  {f.type === "add-link" ? "add" : "make visible"}
                </Badge>
                <div className="field-hint">
                  #{f.rank} · ΔPR {fmtSci(f.deltaPr, true)}
                  {f.deltaDepth !== null && f.deltaDepth !== 0 ? ` · depth ${f.deltaDepth}` : ""}
                </div>
                <Button
                  variant="secondary"
                  className="btn-small"
                  onClick={() =>
                    onPreview(isPreviewed(f) ? null : { donor: f.donor, target: f.target })
                  }
                  aria-pressed={isPreviewed(f)}
                >
                  {isPreviewed(f) ? "Hide preview" : "Preview fix"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Links title="Inbound links" rows={details.inbound} empty="No page links here." />
      <Links
        title="Outbound links"
        rows={details.outbound}
        empty="This page links to no other page."
      />
    </aside>
  );
}
