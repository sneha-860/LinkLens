import { lazy, Suspense, useMemo, useState } from "react";
import { useFixes, useGraph, useIssues } from "../../api/queries.js";
import { POLICIES, type Policy, type SigmaVariant } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { Card, EmptyState, ErrorState, Spinner } from "../../ui/ui.js";
import type { Preview } from "./CytoscapeView.js";
import {
  buildElements,
  DEFAULT_LIMITS,
  DEPTH_BANDS,
  ISSUE_COLOURS,
  nodeDetails,
  type ColourMode,
} from "./model.js";
import { NodePanel } from "./NodePanel.js";

// Cytoscape only loads when the Graph tab is opened.
const CytoscapeView = lazy(() => import("./CytoscapeView.js"));

const CAPS = [100, 300, 1000] as const;

function Legend({ mode }: { mode: ColourMode }) {
  const items =
    mode === "depth"
      ? DEPTH_BANDS.map((b) => [b.label, b.colour])
      : ISSUE_COLOURS.map((c) => [c.label, c.colour]);
  return (
    <div className="legend">
      <span>Size: PageRank.</span>
      {items.map(([label, colour]) => (
        <span key={label}>
          <span className="legend-swatch" style={{ background: colour }} />
          {label}
        </span>
      ))}
      <span>
        Lines: <span className="legend-line legend-body" /> main content ·{" "}
        <span className="legend-line legend-dotted" /> navigation, breadcrumb, pagination ·{" "}
        <span className="legend-line legend-faint" /> footer ·{" "}
        <span className="legend-line legend-preview" /> previewed fix
      </span>
    </div>
  );
}

export function GraphTab() {
  const audit = useCurrentAudit();
  const [policy, setPolicy] = useState<Policy>(audit.policy);
  const [mode, setMode] = useState<ColourMode>("depth");
  const [maxNodes, setMaxNodes] = useState<number>(DEFAULT_LIMITS.maxNodes);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const graph = useGraph(audit.id, policy);
  const issues = useIssues(audit.id, policy);
  const ownPolicy = policy === audit.policy;
  const sigma = (audit.options["sigma"] as SigmaVariant | undefined) ?? "refGateCosine";
  const fixes = useFixes(audit.id, sigma, 50, "target", ownPolicy);
  const allFixes = useMemo(() => (fixes.data?.targets ?? []).flatMap((t) => t.fixes), [fixes.data]);

  const issueList = useMemo(() => issues.data?.issues ?? [], [issues.data]);
  // Built once per graph (not per colour mode, so recolouring keeps the layout).
  const elements = useMemo(
    () =>
      graph.data === undefined
        ? null
        : buildElements(graph.data, issueList, "depth", { ...DEFAULT_LIMITS, maxNodes }),
    [graph.data, issueList, maxNodes],
  );
  const details = useMemo(
    () =>
      selected === null || graph.data === undefined
        ? null
        : nodeDetails(selected, graph.data, issueList, allFixes),
    [selected, graph.data, issueList, allFixes],
  );

  const changePolicy = (p: Policy) => {
    setPolicy(p);
    setSelected(null);
    setPreview(null);
  };

  return (
    <Card
      title="Link graph"
      actions={
        <div className="row">
          <select
            aria-label="Policy"
            value={policy}
            onChange={(e) => changePolicy(e.target.value as Policy)}
          >
            {POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
                {p === audit.policy ? " (this audit)" : ""}
              </option>
            ))}
          </select>
          <div className="segmented" role="group" aria-label="Colour by">
            {(["depth", "issue"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === "depth" ? "Depth" : "Issue"}
              </button>
            ))}
          </div>
          <select
            aria-label="Pages shown"
            value={maxNodes}
            onChange={(e) => setMaxNodes(Number(e.target.value))}
          >
            {CAPS.map((c) => (
              <option key={c} value={c}>
                Top {c} pages
              </option>
            ))}
          </select>
        </div>
      }
    >
      <Legend mode={mode} />
      {graph.isPending ? (
        <Spinner label={`Loading the ${policy} graph`} />
      ) : graph.error ? (
        <ErrorState error={graph.error} />
      ) : elements === null || elements.nodes.length === 0 ? (
        <EmptyState title="The graph is empty" />
      ) : (
        <>
          <p className="field-hint" role="status">
            Showing {elements.stats.shownNodes} of {elements.stats.totalNodes} pages and{" "}
            {elements.stats.shownEdges} of {elements.stats.totalEdges} links
            {elements.stats.orphans > 0
              ? `, with ${elements.stats.orphans} orphans in their own cluster`
              : ""}
            .
            {elements.stats.shownNodes < elements.stats.totalNodes &&
              " Pages with the lowest PageRank are hidden."}
          </p>
          <div className="graph-wrap">
            <Suspense fallback={<Spinner label="Drawing the graph" />}>
              <CytoscapeView
                elements={elements}
                mode={mode}
                selected={selected}
                preview={preview}
                onSelect={setSelected}
              />
            </Suspense>
            {details === null ? (
              <aside className="node-panel">
                <p className="field-hint">
                  Click a page to see its metrics, issues, links and the fixes that point to it.
                  Line style shows where on the page a link sits.
                </p>
              </aside>
            ) : (
              <NodePanel
                details={details}
                fixesAvailable={ownPolicy && fixes.data !== undefined}
                preview={preview}
                onPreview={setPreview}
                onClose={() => {
                  setSelected(null);
                  setPreview(null);
                }}
              />
            )}
          </div>
        </>
      )}
    </Card>
  );
}
