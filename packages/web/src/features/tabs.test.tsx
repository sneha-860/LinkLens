import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosisItem, SensitivityResponse } from "../api/types.js";
import { audit, fix, mockApi, renderAt } from "../test/utils.js";
import { sortFixes } from "./fixes/FixRow.js";
import { samplePoints } from "./diagnosis/Scatter.js";

beforeEach(() => vi.stubGlobal("EventSource", undefined));
afterEach(() => vi.unstubAllGlobals());

const S = "https://example.com";

// ---------- Fixes ----------

const fixes = [
  fix(1, { deltaPr: 0.001, deltaDepth: -1, sigma: 0.9, kappa: 1, type: "make-visible" }),
  fix(2, { deltaPr: 0.004, deltaDepth: -3, sigma: 0.5, kappa: 2 }),
  fix(3, { deltaPr: 0.002, deltaDepth: null, sigma: 0.7, kappa: 1 }),
];

describe("sortFixes", () => {
  it("sorts by any column, ties by rank; a newly reachable page counts as the biggest depth gain", () => {
    expect(sortFixes(fixes, "deltaPr", "desc").map((f) => f.rank)).toEqual([2, 3, 1]);
    expect(sortFixes(fixes, "deltaDepth", "asc").map((f) => f.rank)).toEqual([3, 2, 1]);
    expect(sortFixes(fixes, "kappa", "asc").map((f) => f.rank)).toEqual([1, 3, 2]);
    expect(sortFixes(fixes, "type", "asc").map((f) => f.rank)).toEqual([2, 3, 1]);
  });
});

describe("Fixes tab", () => {
  it("sorts by a column and expands a fix into its explanation card", async () => {
    mockApi({
      "GET /audits/7": audit(),
      "GET /audits/7/fixes": { sigma: "refGateCosine", k: 25, scope: "global", total: 3, fixes },
    });
    renderAt("/audits/7/fixes");
    const table = await screen.findByRole("table");
    const ranks = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => (r as HTMLTableRowElement).cells[0]?.textContent);
    expect(ranks()).toEqual(["1", "2", "3"]);
    await userEvent.click(within(table).getByRole("button", { name: "ΔPR" }));
    expect(ranks()).toEqual(["2", "3", "1"]);
    expect(within(table).getByRole("columnheader", { name: "ΔPR ↓" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await userEvent.click(within(table).getByRole("button", { name: "ΔPR ↓" }));
    expect(ranks()).toEqual(["1", "3", "2"]);

    await userEvent.click(screen.getByText("Add a link from /d3 to /t3."));
    const card = document.querySelector(".explain-card") as HTMLElement;
    expect(card).toHaveTextContent("Why the target: /t3 is 5 clicks deep.");
    expect(card).toHaveTextContent("template reach1 page");
    expect(card).toHaveTextContent("5 → 3");
  });
});

// ---------- Diagnosis ----------

const item = (
  id: string,
  c: DiagnosisItem["case"],
  rho: number,
  omega: number,
  severity: number,
): DiagnosisItem => ({
  id,
  case: c,
  label: c,
  source: `${S}/s-${id}`,
  target: `${S}/t-${id}`,
  ref: rho * 2,
  rho,
  omega,
  severity,
  recommendation: null,
  explanation: `sentence ${id} (${c})`,
});
const diagnosis = {
  alpha: 0.1,
  epsilon: 0.2,
  counts: { v4: 2, v3: 1, v2: 1, v1: 1, pairs: 7, unclassified: 2 },
  diagnoses: [
    item("a", "v4", 0.6, 0, 0.6),
    item("b", "v4", 0.3, 0, 0.3),
    item("c", "v3", 0.4, 0.05, 0.35),
    item("d", "v2", 0.5, 0.5, 0),
    item("e", "v1", 0.02, 0.9, 0.88),
  ],
};

describe("samplePoints", () => {
  it("keeps everything under the cap and strides evenly above it", () => {
    expect(samplePoints([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(
      samplePoints(
        Array.from({ length: 10 }, (_, i) => i),
        5,
      ),
    ).toEqual([0, 2, 4, 6, 8]);
  });
});

describe("Diagnosis tab", () => {
  it("shows the four counts, filters by case, sorts by severity and plots ρ against ω with α lines", async () => {
    mockApi({ "GET /audits/7": audit(), "GET /audits/7/diagnosis": diagnosis });
    renderAt("/audits/7/diagnosis");
    const cases = await screen.findByRole("group", { name: "Cases" });
    expect(
      within(cases)
        .getAllByRole("button")
        .map((b) => b.querySelector(".stat-value")?.textContent),
    ).toEqual(["2", "1", "1", "1"]);

    const svg = screen.getByRole("img", { name: /ρ: share of the source's REF/ });
    expect(svg.querySelectorAll("circle")).toHaveLength(5);
    // α = 0.1 on both axes: x = 48 + 0.1 × 456, y = 320 − 0.1 × 304.
    expect(screen.getByTestId("alpha-x")).toHaveAttribute("x1", String(48 + 0.1 * 456));
    expect(screen.getByTestId("alpha-y")).toHaveAttribute("y1", String(320 - 0.1 * 304));

    const table = screen.getAllByRole("table")[0] as HTMLElement;
    const firstSentence = () => within(table).getAllByRole("row")[1]?.textContent ?? "";
    expect(firstSentence()).toContain("sentence e (v1)"); // severity 0.88 first
    await userEvent.click(within(table).getByRole("button", { name: /Severity/ }));
    expect(firstSentence()).toContain("sentence d (v2)"); // ascending: 0

    await userEvent.click(within(cases).getByRole("button", { name: /v4 Missing/ }));
    expect(screen.getByText("v4 Missing (2)")).toBeInTheDocument();
    expect(svg.querySelectorAll("circle")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "REF" }));
    expect(screen.getByTestId("epsilon-x")).toHaveAttribute("x1", String(48 + 0.2 * 456));
    expect(screen.queryByTestId("alpha-x")).toBeNull();
  });
});

// ---------- Orphans ----------

describe("Orphans tab", () => {
  it("ticks each URL's channels, shows each channel's marginal yield, and lists rescue donors", async () => {
    const stats = (total: number, exclusive: number, orphans: number) => ({
      total,
      exclusive,
      orphans,
    });
    mockApi({
      "GET /audits/7": audit(),
      "GET /audits/7/reconciliation": {
        policy: "P3",
        orphans: 1,
        channels: {
          link_graph: stats(9, 7, 0),
          xml_sitemap: stats(4, 0, 1),
          robots_sitemap: stats(3, 0, 0),
          html_sitemap: stats(0, 0, 0),
          feed: stats(2, 1, 1),
          llms_txt: stats(1, 0, 0),
        },
        inventory: [
          {
            node: `${S}/lost`,
            channels: ["xml_sitemap", "feed"],
            urls: [],
            reachable: false,
            depth: null,
            orphan: true,
          },
          {
            node: `${S}/`,
            channels: ["link_graph", "xml_sitemap"],
            urls: [],
            reachable: true,
            depth: 0,
            orphan: false,
          },
        ],
      },
      "GET /audits/7/orphans": {
        counts: { orphans: 1, scored: 1, withDonors: 1 },
        orphans: [
          {
            node: `${S}/lost`,
            channels: ["xml_sitemap", "feed"],
            revealedBy: ["xml_sitemap", "feed"],
            status: "scored",
            shortlisted: 1,
            donors: [
              {
                rank: 1,
                donor: `${S}/about`,
                ref: 0.42,
                deltaPr: 0.003,
                depthAfter: 2,
                explanation: {
                  sentence: "s",
                  lines: ["Why the target", "Why this donor: REF 0.42."],
                },
              },
            ],
          },
        ],
      },
    });
    renderAt("/audits/7/orphans");
    const table = (await screen.findByText("Reconciliation"))
      .closest("section")
      ?.querySelector("table") as HTMLElement;
    const lost = within(table).getByText("/lost").closest("tr") as HTMLTableRowElement;
    expect([...lost.cells].map((c) => c.textContent)).toEqual([
      "/lost",
      "",
      "✓",
      "",
      "",
      "✓",
      "",
      "orphan",
    ]);
    const yieldRow = within(table)
      .getByText("Found only here (marginal yield)")
      .closest("tr") as HTMLTableRowElement;
    expect([...yieldRow.cells].slice(1, 7).map((c) => c.textContent)).toEqual([
      "7",
      "0",
      "0",
      "0",
      "1",
      "0",
    ]);
    expect(within(table).queryByText("/")).toBeNull(); // orphans only by default
    await userEvent.click(screen.getByRole("button", { name: "All URLs (2)" }));
    expect(within(table).getByText("/")).toBeInTheDocument();

    expect(await screen.findByText("Why this donor: REF 0.42.")).toBeInTheDocument();
    expect(screen.getByText("/about")).toBeInTheDocument();
  });
});

// ---------- Canonicalisation ----------

const row = (policy: string, extra: Partial<SensitivityResponse["policies"][number]> = {}) => ({
  policy,
  policyVersion: `${policy}@1.0.0`,
  nodes: 40,
  edges: 300,
  reachable: 38,
  largestScc: 30,
  orphans: 3,
  issues: 9,
  meanDepth: 2.1,
  pagerankSpearman: 0.93,
  meanDepthShift: -0.25,
  meanAbsDepthShift: 0.4,
  fixesRanked: null,
  topFixesJaccard: null,
  ...extra,
});

describe("Canonicalisation tab", () => {
  it("shows the metrics per policy and starts ranking fixes under the other policies", async () => {
    let job: unknown = null;
    const { calls } = mockApi({
      "GET /audits/7": audit(),
      "GET /audits/7/sensitivity": () => ({
        baselinePolicy: "P3",
        sigma: "refGateCosine",
        k: 10,
        fixesJob: job,
        policies: ["P0", "P1", "P2", "P3", "P4", "P5"].map((p) =>
          p === "P3"
            ? row(p, {
                pagerankSpearman: 1,
                meanDepthShift: 0,
                meanAbsDepthShift: 0,
                fixesRanked: 12,
                topFixesJaccard: 1,
              })
            : row(p),
        ),
      }),
      "POST /audits/7/sensitivity/fixes": () => {
        job = { status: "running", done: ["P0"], current: "P1", error: null };
        return { job };
      },
    });
    renderAt("/audits/7/canonicalisation");
    const table = await screen.findByRole("table");
    const p0 = within(table).getByText("P0").closest("tr") as HTMLTableRowElement;
    expect([...p0.cells].slice(1).map((c) => c.textContent)).toEqual([
      "40",
      "3",
      "not ranked",
      "0.93",
      "-0.25",
      "0.40",
    ]);
    const p3 = within(table).getByText("P3").closest("tr") as HTMLTableRowElement;
    expect([...p3.cells].slice(3).map((c) => c.textContent)).toEqual([
      "1.00",
      "1.00",
      "0.00",
      "0.00",
    ]);
    expect(p3).toHaveTextContent("this audit");

    await userEvent.click(screen.getByRole("button", { name: "Rank fixes under all policies" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/audits/7/sensitivity/fixes"),
      ).toBe(true),
    );
    expect(await screen.findByText("Ranking fixes under P1 (1 of 6 done)…")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Top k fixes"), "25");
    await waitFor(() => expect(calls.map((c) => c.search)).toContain("?k=25"));
  });
});

// ---------- Export ----------

describe("Export tab", () => {
  it("links the zip, every JSON/CSV file and the printable report", async () => {
    mockApi({ "GET /audits/7": audit() });
    renderAt("/audits/7/export");
    expect(await screen.findByRole("link", { name: "Open printable report" })).toHaveAttribute(
      "href",
      "/api/audits/7/report",
    );
    expect(screen.getByRole("link", { name: "Download linklens-audit-7.zip" })).toHaveAttribute(
      "href",
      "/api/audits/7/export",
    );
    const fixesRow = screen
      .getByText("fixes", { selector: "td" })
      .closest("tr") as HTMLTableRowElement;
    expect(within(fixesRow).getByRole("link", { name: "CSV" })).toHaveAttribute(
      "href",
      "/api/audits/7/export/fixes.csv",
    );
    expect(within(fixesRow).getByRole("link", { name: "JSON" })).toHaveAttribute(
      "href",
      "/api/audits/7/export/fixes.json",
    );
    const summaryRow = screen
      .getByText("summary", { selector: "td" })
      .closest("tr") as HTMLTableRowElement;
    expect(within(summaryRow).queryByRole("link", { name: "CSV" })).toBeNull();
  });
});
