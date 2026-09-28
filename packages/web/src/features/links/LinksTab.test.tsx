import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkHealthResponse } from "../../api/types.js";
import { audit, mockApi, renderAt } from "../../test/utils.js";

beforeEach(() => vi.stubGlobal("EventSource", undefined));
afterEach(() => vi.unstubAllGlobals());

const S = "https://example.com";
const source = (path: string, anchors: string[], regions = ["main"]) => ({
  page: S + path,
  node: S + path,
  links: 1,
  anchors,
  regions,
});
const report: LinkHealthResponse = {
  version: "link-health@1.0.0",
  runId: 7,
  policyVersion: "P3@1.0.0",
  summary: {
    internalLinks: 120,
    checkedLinks: 110,
    uncheckedLinks: 8,
    failedLinks: 2,
    brokenTargets: 2,
    brokenLinks: 4,
    brokenSourcePages: 3,
    statuses: { "404": 1, "500": 1 },
    redirectTargets: 5,
    chainTargets: 1,
    chainLinks: 1,
    maxHops: 2,
    minChainHops: 2,
  },
  broken: [
    {
      url: `${S}/missing`,
      node: `${S}/missing`,
      finalUrl: `${S}/missing`,
      finalStatus: 404,
      chain: [],
      error: null,
      links: 3,
      sources: [source("/", ["Missing page"], ["nav"]), source("/blog/", ["Old post"])],
      class: "4xx",
      hops: 0,
    },
    {
      url: `${S}/broken`,
      node: `${S}/broken`,
      finalUrl: `${S}/broken`,
      finalStatus: 500,
      chain: [],
      error: "HTTP 500",
      links: 1,
      sources: [source("/", ["Broken"])],
      class: "5xx",
      hops: 0,
    },
  ],
  redirectChains: [
    {
      url: `${S}/chain-a`,
      node: `${S}/chain-a`,
      finalUrl: `${S}/about`,
      finalStatus: 200,
      chain: [
        { url: `${S}/chain-a`, statusCode: 302 },
        { url: `${S}/chain-b`, statusCode: 301 },
      ],
      error: null,
      links: 1,
      sources: [source("/", ["Redirect chain"])],
      hops: 2,
      endsBroken: false,
    },
  ],
};

describe("Links tab", () => {
  it("summarises and lists broken links with their source pages, filterable by status class", async () => {
    mockApi({ "GET /audits/7": audit(), "GET /audits/7/links": report });
    renderAt("/audits/7/links");
    expect(await screen.findByText("Broken link targets")).toBeInTheDocument();
    expect(screen.getByText("4 links on 3 pages")).toBeInTheDocument();
    expect(screen.getByText("110 of 120")).toBeInTheDocument();

    const broken = screen
      .getByRole("heading", { name: "Broken internal links" })
      .closest("section") as HTMLElement;
    const rows = () => within(broken).getAllByRole("row").slice(1);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveTextContent("404/missing3");

    // The source pages, anchors and regions open under the row.
    await userEvent.click(
      within(rows()[0] as HTMLElement).getByRole("button", { name: "2 pages" }),
    );
    expect(broken).toHaveTextContent("“Missing page”");
    expect(broken).toHaveTextContent("“Old post”");
    expect(within(broken).getByText("nav")).toBeInTheDocument();

    await userEvent.click(within(broken).getByRole("button", { name: "5xx (1)" }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("500/broken");
  });

  it("lists redirect chains hop by hop", async () => {
    mockApi({ "GET /audits/7": audit(), "GET /audits/7/links": report });
    renderAt("/audits/7/links");
    const card = (
      await screen.findByRole("heading", { name: "Redirect chains (2+ hops)" })
    ).closest("section") as HTMLElement;
    const row = within(card).getAllByRole("row")[1] as HTMLElement;
    expect(row).toHaveTextContent("2/chain-a/about 200");
    await userEvent.click(within(row).getByRole("button", { name: "1 page" }));
    const chain = card.querySelector(".link-chain") as HTMLElement;
    expect(
      within(chain)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["/chain-a 302", "/chain-b 301", "/about 200"]);
  });

  it("waits for the finished crawl", async () => {
    const { calls } = mockApi({
      "GET /audits/7": audit({
        crawl: { status: "running", pageCap: 500, urlsFetched: 3 },
      } as never),
    });
    renderAt("/audits/7/links");
    expect(
      await screen.findByText("The link report needs the finished crawl."),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/audits/7/links")).toBe(false);
  });
});
