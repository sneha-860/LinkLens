import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { audit, mockApi, renderAt } from "../test/utils.js";

afterEach(() => vi.unstubAllGlobals());

describe("audits list", () => {
  it("lists audits with their status and stage, and opens one", async () => {
    vi.stubGlobal("EventSource", undefined);
    mockApi({
      "GET /audits": {
        audits: [
          {
            id: 8,
            url: "https://b.test/",
            policy: "P0",
            status: "running",
            currentStage: "ref",
            createdAt: "2026-09-26T11:00:00Z",
            updatedAt: "2026-09-26T11:00:00Z",
          },
          {
            id: 7,
            url: "https://a.test/",
            policy: "P3",
            status: "completed",
            currentStage: null,
            createdAt: "2026-09-26T10:00:00Z",
            updatedAt: "2026-09-26T10:00:00Z",
          },
        ],
      },
      "GET /audits/7": audit({ url: "https://a.test/" }),
      "GET /audits/7/summary": {
        status: 409,
        body: { error: { code: "not_ready", message: "x" } },
      },
    });
    const { router } = renderAt("/");
    expect(await screen.findByText("https://b.test/")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("REF")).toBeInTheDocument();
    await userEvent.click(screen.getByText("https://a.test/"));
    expect(router.state.location.pathname).toBe("/audits/7/summary");
  });

  it("invites you to start one when there are none", async () => {
    mockApi({ "GET /audits": { audits: [] } });
    renderAt("/");
    expect(await screen.findByText("No audits yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start your first audit" })).toHaveAttribute(
      "href",
      "/audits/new",
    );
  });

  it("explains when the API cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    renderAt("/");
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot reach the LinkLens API");
  });
});
