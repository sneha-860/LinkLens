import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { audit, mockApi, renderAt } from "../../test/utils.js";
import { validate } from "./NewAuditForm.js";

afterEach(() => vi.unstubAllGlobals());

describe("validate", () => {
  it("accepts a full http(s) URL and a cap of 1–500", () => {
    expect(validate({ url: "https://example.com/", pageCap: "500" })).toEqual({});
    expect(validate({ url: "example.com", pageCap: "10" }).url).toBeDefined();
    expect(validate({ url: "ftp://example.com/", pageCap: "10" }).url).toMatch(/http/);
    expect(validate({ url: "https://example.com/", pageCap: "0" }).pageCap).toBeDefined();
    expect(validate({ url: "https://example.com/", pageCap: "501" }).pageCap).toBeDefined();
    expect(validate({ url: "https://example.com/", pageCap: "2.5" }).pageCap).toBeDefined();
  });
});

describe("new audit form", () => {
  it("shows errors only after submitting, and does not call the API", async () => {
    const { calls } = mockApi({});
    renderAt("/audits/new");
    await screen.findByLabelText("Site URL"); // after the sign-in gate
    expect(screen.queryByText(/full address/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start audit" }));
    expect(screen.getByText(/Enter the site's full address/)).toBeInTheDocument();
    expect(screen.getByLabelText("Site URL")).toHaveAttribute("aria-invalid", "true");
    expect(calls).toHaveLength(0);
  });

  it("creates the audit with the chosen options, uploads the CSV, then opens the audit", async () => {
    const { calls } = mockApi({
      "POST /audits": { id: 7, status: "queued", policy: "P5" },
      "POST /audits/7/analytics": { id: 7, imported: 1, rerunFrom: "prominence" },
      "GET /audits/7": audit({ status: "running", active: true }, 0),
      "GET /audits/7/summary": {
        status: 409,
        body: { error: { code: "not_ready", message: "x" } },
      },
    });
    renderAt("/audits/new");
    await screen.findByLabelText("Site URL"); // after the sign-in gate
    await userEvent.type(screen.getByLabelText("Site URL"), "https://example.com/");
    await userEvent.clear(screen.getByLabelText("Page cap"));
    await userEvent.type(screen.getByLabelText("Page cap"), "120");
    await userEvent.selectOptions(screen.getByLabelText("Canonicalisation policy"), "P5");
    await userEvent.selectOptions(screen.getByLabelText("σ variant (fix scoring)"), "blended");
    const csv = new File(["source_url,target_url,clicks\n/a,/b,3\n"], "ga.csv", {
      type: "text/csv",
    });
    await userEvent.upload(screen.getByLabelText("Analytics CSV (optional)"), csv);
    await userEvent.click(screen.getByRole("button", { name: "Start audit" }));

    // The audit page opened (its date format depends on the machine's time zone).
    await screen.findByText(/^Audit #7 · policy P3 · started /);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual(["/audits", "/audits/7/analytics"]);
    expect(JSON.parse(String(posts[0]?.body))).toEqual({
      url: "https://example.com/",
      pageCap: 120,
      policy: "P5",
      options: { sigma: "blended" },
    });
    expect(posts[1]?.search).toBe("?name=ga.csv");
    expect(posts[1]?.body).toBe("source_url,target_url,clicks\n/a,/b,3\n");
  });

  it("shows the API's error (e.g. no contact URL configured)", async () => {
    mockApi({
      "POST /audits": {
        status: 400,
        body: { error: { code: "invalid_audit", message: "config.userAgent is not identifying" } },
      },
    });
    renderAt("/audits/new");
    await screen.findByLabelText("Site URL"); // after the sign-in gate
    await userEvent.type(screen.getByLabelText("Site URL"), "https://example.com/");
    await userEvent.click(screen.getByRole("button", { name: "Start audit" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("config.userAgent is not identifying"),
    );
  });
});
