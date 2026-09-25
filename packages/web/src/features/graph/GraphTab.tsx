import { lazy, Suspense, useState } from "react";
import { useGraph } from "../../api/queries.js";
import { POLICIES, type GraphNodeAttributes, type Policy } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { fmtSci, shortUrl } from "../../ui/format.js";
import { Card, EmptyState, QueryView, Spinner } from "../../ui/ui.js";
import { DEPTH_COLOURS, depthColour } from "./colours.js";

// WebGL (sigma) only loads when the tab is opened.
const GraphView = lazy(() => import("./GraphView.js"));

export function GraphTab() {
  const audit = useCurrentAudit();
  const [policy, setPolicy] = useState<Policy>(audit.policy);
  const [selected, setSelected] = useState<{ node: string; attrs: GraphNodeAttributes } | null>(
    null,
  );
  const graph = useGraph(audit.id, policy);

  return (
    <Card
      title="Link graph"
      actions={
        <select
          aria-label="Policy"
          value={policy}
          onChange={(e) => setPolicy(e.target.value as Policy)}
        >
          {POLICIES.map((p) => (
            <option key={p} value={p}>
              {p}
              {p === audit.policy ? " (this audit)" : ""}
            </option>
          ))}
        </select>
      }
    >
      <div className="legend" style={{ marginBottom: 8 }}>
        Size: PageRank · Colour: clicks from the home page
        {DEPTH_COLOURS.map((c, i) => (
          <span key={c}>
            <span className="legend-swatch" style={{ background: c }} />
            {i === DEPTH_COLOURS.length - 1 ? `${i}+` : i}
          </span>
        ))}
        <span>
          <span className="legend-swatch" style={{ background: depthColour(null) }} />
          unreachable
        </span>
      </div>
      <QueryView query={graph}>
        {(g) =>
          g.graph.nodes.length === 0 ? (
            <EmptyState title="The graph is empty" />
          ) : (
            <div className="graph-wrap">
              <Suspense fallback={<Spinner label="Drawing the graph" />}>
                <GraphView data={g} onSelect={setSelected} />
              </Suspense>
              <aside>
                {selected === null ? (
                  <p className="field-hint">
                    {g.graph.nodes.length} pages, {g.graph.edges.length} links under{" "}
                    {g.policyVersion}. Click a page for its metrics.
                  </p>
                ) : (
                  <>
                    <h3 className="pair" style={{ marginBottom: 8, wordBreak: "break-all" }}>
                      {shortUrl(selected.node)}
                    </h3>
                    <dl className="props">
                      <dt>PageRank</dt>
                      <dd>{fmtSci(selected.attrs.pagerank ?? 0)}</dd>
                      <dt>Depth</dt>
                      <dd>{selected.attrs.depth ?? "unreachable"}</dd>
                      <dt>Links in</dt>
                      <dd>{selected.attrs.inDegree ?? 0}</dd>
                      <dt>Links out</dt>
                      <dd>{selected.attrs.outDegree ?? 0}</dd>
                      <dt>Betweenness</dt>
                      <dd>{(selected.attrs.betweennessNormalized ?? 0).toFixed(3)}</dd>
                      <dt>Crawled</dt>
                      <dd>{selected.attrs.crawled ? "yes" : "no"}</dd>
                    </dl>
                  </>
                )}
              </aside>
            </div>
          )
        }
      </QueryView>
    </Card>
  );
}
