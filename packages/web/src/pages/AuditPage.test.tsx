import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Summary } from "../api/types.js";
import { applyEvent, fromAudit } from "../api/useAuditEvents.js";
import { audit, FakeEventSource, fix, mockApi, renderAt } from "../test/utils.js";

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.last = null;
});
afterEach(() => vi.unstubAllGlobals());

const summary: Summary = {
  id: 7,
  url: "https://example.com/",
  policy: "P3",
  status: "completed",
  progress: { completedStages: 18, totalStages: 18, fraction: 1 },
  durationMs: 12_300,
  pages: 42,
  graph: { nodes: 40, edges: 310, reachable: 38, sccCount: 3 },
  discovery: {
    inventory: 50,
    orphans: 3,
    channels: {
      link_graph: { total: 40, exclusive: 30, orphans: 0 },
      xml_sitemap: { total: 20, exclusive: 2, orphans: 2 },
      robots_sitemap: { total: 20, exclusive: 0, orphans: 1 },
      html_sitemap: { total: 5, exclusive: 0, orphans: 0 },
      feed: { total: 4, exclusive: 1, orphans: 1 },
      llms_txt: { total: 0, exclusive: 0, orphans: 0 },
    },
  },
  issues: {
    total: 9,
    byType: { orphan: 3, "deep-page": 4, "dead-end": 2 },
    bySeverity: { high: 3, medium: 5, low: 1 },
    nodesWithIssues: 7,
    pagesAudited: 42,
  },
  diagnosis: { v4: 5, v3: 2, v2: 10, v1: 1, pairs: 30, unclassified: 12 },
  fixes: { total: 17, sigma: "refGateCosine", top: [] },
  orphans: { orphans: 3, scored: 3, withDonors: 2 },
};

const completedApi = () =>
  mockApi({
    "GET /audits/7": audit(),
    "GET /audits/7/summary": summary,
    "GET /audits/7/fixes": {
      sigma: "refGateCosine",
      k: 10,
      scope: "global",
      total: 7,
      fixes: [1, 2, 3, 4, 5, 6, 7].map((r) => fix(r)),
    },
  });

describe("applyEvent", () => {
  it("updates one stage, the crawl counter, and marks done", () => {
    let s = fromAudit(audit({ status: "running", active: true }, 0));
    s = applyEvent(s, { type: "stage", stage: "crawl", status: "running" });
    expect(s.stages[0]).toMatchObject({ status: "running", durationMs: null });
    s = applyEvent(s, {
      type: "progress",
      pagesFetched: 5,
      admitted: 9,
      queueSize: 4,
      url: "https://example.com/a",
    });
    expect(s.crawl).toEqual({ pagesFetched: 5, admitted: 9, url: "https://example.com/a" });
    s = applyEvent(s, {
      type: "stage",
      stage: "crawl",
      status: "failed",
      durationMs: 20,
      error: "boom",
    });
    expect(s.stages[0]).toMatchObject({ status: "failed", durationMs: 20, error: "boom" });
    expect(s.stages[1]?.status).toBe("pending");
    expect(applyEvent(s, { type: "done", status: "failed" }).done).toBe(true);
  });
});

describe("audit page: live progress", () => {
  it("follows the server-sent events, then shows the results when done", async () => {
    let finished = false;
    mockApi({
      "GET /audits/7": () =>
        finished ? audit() : audit({ status: "running", active: true, currentStage: "crawl" }, 0),
      "GET /audits/7/summary": summary,
      "GET /audits/7/fixes": {
        sigma: "refGateCosine",
        k: 10,
        scope: "global",
        total: 0,
        fixes: [],
      },
    });
    renderAt("/audits/7");
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const es = FakeEventSource.last as FakeEventSource;
    expect(es.url).toBe("/api/audits/7/events");

    act(() => {
      es.emit("snapshot", audit({ status: "running", active: true }, 0));
      es.emit("stage", { type: "stage", stage: "crawl", status: "running" });
      es.emit("progress", {
        type: "progress",
        pagesFetched: 12,
        admitted: 30,
        queueSize: 18,
        url: "https://example.com/blog/x",
      });
    });
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("12 / 30 URLs · /blog/x")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");

    act(() => {
      es.emit("stage", { type: "stage", stage: "crawl", status: "completed", durationMs: 4_200 });
      es.emit("stage", { type: "stage", stage: "extract", status: "running" });
    });
    const stages = screen.getByRole("list", { name: "Stages" });
    expect(within(stages).getByText("Crawl").closest("li")).toHaveAttribute(
      "data-status",
      "completed",
    );
    expect(within(stages).getByText("4.2 s")).toBeInTheDocument();
    expect(within(stages).getByText("Extract").closest("li")).toHaveAttribute(
      "data-status",
      "running",
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      String(Math.round(100 / 18)),
    );

    finished = true;
    act(() => es.emit("done", { type: "done", status: "completed" }));
    expect(es.closed).toBe(true);
    // The audit is refetched: finished audits show no progress panel.
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(await screen.findByText("Pages crawled")).toBeInTheDocument();
  });

  it("offers to resume a failed audit from the failed stage", async () => {
    const failed = audit({ status: "failed", error: "boom" }, 8);
    failed.stages = failed.stages.map((s, i) =>
      i === 8 ? { ...s, status: "failed", error: "boom" } : s,
    );
    const { calls } = mockApi({
      "GET /audits/7": failed,
      "POST /audits/7/resume": { id: 7, status: "running" },
      "GET /audits/7/summary": summary,
    });
    renderAt("/audits/7/summary");
    const button = await screen.findByRole("button", { name: "Resume from REF" });
    expect(screen.getByRole("alert")).toHaveTextContent("REF failed: boom");
    await userEvent.click(button);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/audits/7/resume")).toBe(true),
    );
  });
});

describe("audit page: tabs", () => {
  it("opens the Summary tab by default and switches tabs through the URL", async () => {
    completedApi();
    const { router } = renderAt("/audits/7");
    await screen.findByText("Pages crawled");
    expect(router.state.location.pathname).toBe("/audits/7/summary");
    const tabs = screen.getByRole("navigation", { name: "Audit sections" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Summary", "Graph", "Fixes", "Diagnosis", "Orphans", "Canonicalisation", "Export"]);
    await userEvent.click(within(tabs).getByRole("link", { name: "Export" }));
    expect(router.state.location.pathname).toBe("/audits/7/export");
    expect(screen.getByRole("link", { name: "Download linklens-audit-7.zip" })).toHaveAttribute(
      "href",
      "/api/audits/7/export",
    );
  });

  it("summarises issues, pages, orphans by channel and the top 5 fixes", async () => {
    completedApi();
    renderAt("/audits/7/summary");
    const pages = await screen.findByText("Pages crawled");
    expect(pages.previousSibling).toHaveTextContent("42");
    expect(
      screen.getByText("Issues", { selector: ".stat-label" }).previousSibling,
    ).toHaveTextContent("9");
    expect(screen.getByText("3 high")).toBeInTheDocument();
    expect(screen.getByText("Deep pages").parentElement).toHaveTextContent("4");
    expect(screen.getByText("XML sitemap").parentElement).toHaveTextContent("2");
    expect(screen.getByText("RSS / Atom").parentElement).toHaveTextContent("1");
    expect(screen.queryByText("Link graph", { selector: ".bar-label" })).toBeNull();
    // Top 5 of the 7 returned fixes.
    const top = await screen.findByText("Top 5 fixes");
    const table = within(top.closest("section") as HTMLElement).getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 5);
    expect(within(table).getByText("Add a link from /d1 to /t1.")).toBeInTheDocument();
  });

  it("expands a fix to its explanation lines", async () => {
    completedApi();
    renderAt("/audits/7/fixes");
    const row = (await screen.findByText("Add a link from /d2 to /t2.")).closest(
      "tr",
    ) as HTMLElement;
    expect(screen.queryByText("Why the target: /t2 is 5 clicks deep.")).toBeNull();
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Why the target: /t2 is 5 clicks deep.")).toBeInTheDocument();
  });

  it("asks the API again when the σ variant or k changes", async () => {
    const { calls } = completedApi();
    renderAt("/audits/7/fixes");
    await screen.findByText("Add a link from /d1 to /t1.");
    await userEvent.selectOptions(screen.getByLabelText("σ variant"), "refOnly");
    await userEvent.selectOptions(screen.getByLabelText("Top k"), "25");
    await waitFor(() =>
      expect(calls.map((c) => c.search)).toContain("?sigma=refOnly&k=25&scope=global"),
    );
  });

  it("says a tab is not ready yet when the pipeline has not produced it", async () => {
    mockApi({
      "GET /audits/7": audit({ status: "running", active: true }, 3),
      "GET /audits/7/orphans": {
        status: 409,
        body: { error: { code: "not_ready", message: "x" } },
      },
    });
    renderAt("/audits/7/orphans");
    expect(await screen.findByText("Not ready yet")).toBeInTheDocument();
  });
});
