import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphResponse } from "../../api/types.js";
import { audit, fix, mockApi, renderAt } from "../../test/utils.js";
import type { CytoscapeViewProps } from "./CytoscapeView.js";

// jsdom has no canvas: stand in for Cytoscape with buttons that expose what it was given.
vi.mock("./CytoscapeView.js", () => ({
  default: (p: CytoscapeViewProps) => (
    <div
      data-testid="cytoscape"
      data-mode={p.mode}
      data-selected={p.selected ?? ""}
      data-preview={p.preview === null ? "" : `${p.preview.donor}->${p.preview.target}`}
    >
      {p.elements.nodes.map((n) => (
        <button key={n.data.id} type="button" onClick={() => p.onSelect(n.data.id)}>
          node {n.data.id}
        </button>
      ))}
      <span data-testid="edges">{p.elements.edges.length}</span>
    </div>
  ),
}));

beforeEach(() => vi.stubGlobal("EventSource", undefined));
afterEach(() => vi.unstubAllGlobals());

const S = "https://example.com";
const graph = (policy: string, extra = 0): GraphResponse => ({
  policy: policy as GraphResponse["policy"],
  policyVersion: `${policy}@1.0.0`,
  graph: {
    attributes: { seedNode: `${S}/` },
    nodes: [
      {
        key: `${S}/`,
        attributes: { pagerank: 0.5, depth: 0, crawled: true, inDegree: 1, outDegree: 2 },
      },
      {
        key: `${S}/t1`,
        attributes: { pagerank: 0.3, depth: 5, crawled: true, inDegree: 1, outDegree: 0 },
      },
      ...Array.from({ length: extra }, (_, i) => ({
        key: `${S}/x${i}`,
        attributes: { pagerank: 0.001, depth: 2 },
      })),
    ],
    edges: [
      { source: `${S}/`, target: `${S}/t1`, attributes: { domRegion: "footer", anchorText: "T1" } },
      { source: `${S}/t1`, target: `${S}/`, attributes: { domRegion: "nav", anchorText: "Home" } },
    ],
  },
});
const issuesFor = {
  issues: [
    {
      id: "deep-page:t1",
      type: "deep-page",
      node: `${S}/t1`,
      severity: "high",
      evidence: { depth: 5, threshold: 3 },
    },
    {
      id: "orphan:o",
      type: "orphan",
      node: `${S}/lost`,
      severity: "high",
      evidence: { channels: ["xml_sitemap"] },
    },
  ],
};

function api() {
  return mockApi({
    "GET /audits/7": audit(),
    "GET /audits/7/graph": (_init: unknown, url: URL) =>
      graph(
        url.searchParams.get("policy") ?? "P3",
        url.searchParams.get("policy") === "P0" ? 400 : 0,
      ),
    "GET /audits/7/issues": issuesFor,
    "GET /audits/7/fixes": {
      sigma: "refGateCosine",
      k: 50,
      scope: "target",
      total: 1,
      targets: [{ target: `${S}/t1`, fixes: [fix(1, { donor: `${S}/d1`, target: `${S}/t1` })] }],
    },
  });
}

describe("Graph tab", () => {
  it("draws the graph with the orphan cluster and a cap notice", async () => {
    api();
    renderAt("/audits/7/graph");
    expect(await screen.findByTestId("cytoscape")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `node ${S}/lost` })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing 3 of 3 pages and 2 of 2 links, with 1 orphans in their own cluster.",
    );
  });

  it("re-fetches the graph and issues when the policy changes, and caps large graphs", async () => {
    const { calls } = api();
    renderAt("/audits/7/graph");
    await screen.findByTestId("cytoscape");
    await userEvent.selectOptions(screen.getByLabelText("Policy"), "P0");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Showing 301 of 403 pages"),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Pages with the lowest PageRank are hidden.",
    );
    expect(calls.filter((c) => c.path === "/audits/7/graph").map((c) => c.search)).toEqual([
      "?policy=P3",
      "?policy=P0",
    ]);
    expect(calls.filter((c) => c.path === "/audits/7/issues").map((c) => c.search)).toEqual([
      "?policy=P3",
      "?policy=P0",
    ]);
    await userEvent.selectOptions(screen.getByLabelText("Pages shown"), "1000");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Showing 403 of 403 pages"),
    );
  });

  it("toggles the colouring between depth and issue type", async () => {
    api();
    renderAt("/audits/7/graph");
    const view = await screen.findByTestId("cytoscape");
    expect(view).toHaveAttribute("data-mode", "depth");
    expect(screen.getByText("4–5 clicks")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Issue" }));
    expect(view).toHaveAttribute("data-mode", "issue");
    expect(screen.getByText("Deep page")).toBeInTheDocument();
  });

  it("opens a side panel with metrics, issues, links and fixes, and previews a fix", async () => {
    api();
    renderAt("/audits/7/graph");
    await userEvent.click(await screen.findByRole("button", { name: `node ${S}/t1` }));
    const panel = screen.getByRole("complementary", { name: "Page details" });
    expect(within(panel).getByText("PageRank").nextSibling).toHaveTextContent("3.00e-1");
    expect(within(panel).getByText("deep-page")).toBeInTheDocument();
    expect(within(panel).getByText("depth 5 (> 3)")).toBeInTheDocument();
    expect(
      within(panel).getByText("Inbound links", { exact: false }).closest("section"),
    ).toHaveTextContent(/Footer\s*“T1”/);
    expect(
      within(panel).getByText("Outbound links", { exact: false }).closest("section"),
    ).toHaveTextContent("Navigation");

    const view = screen.getByTestId("cytoscape");
    expect(view).toHaveAttribute("data-selected", `${S}/t1`);
    await userEvent.click(within(panel).getByRole("button", { name: "Preview fix" }));
    expect(view).toHaveAttribute("data-preview", `${S}/d1->${S}/t1`);
    await userEvent.click(within(panel).getByRole("button", { name: "Hide preview" }));
    expect(view).toHaveAttribute("data-preview", "");
  });

  it("explains that fixes exist only under the audit's policy", async () => {
    api();
    renderAt("/audits/7/graph");
    await screen.findByTestId("cytoscape");
    await userEvent.selectOptions(screen.getByLabelText("Policy"), "P5");
    await userEvent.click(await screen.findByRole("button", { name: `node ${S}/t1` }));
    expect(screen.getByText("Fixes are ranked under the audit's policy only.")).toBeInTheDocument();
  });

  it("shows an orphan that is not in the link graph", async () => {
    api();
    renderAt("/audits/7/graph");
    await userEvent.click(await screen.findByRole("button", { name: `node ${S}/lost` }));
    expect(
      screen.getByText("Not in the link graph: no crawled page links to it."),
    ).toBeInTheDocument();
    expect(screen.getByText("found via xml_sitemap")).toBeInTheDocument();
  });
});
