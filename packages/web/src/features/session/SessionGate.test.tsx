import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, renderAt } from "../../test/utils.js";

afterEach(() => vi.unstubAllGlobals());

describe("sign-in gate", () => {
  it("asks for the key when the server needs one, then shows the page", async () => {
    let signedIn = false;
    const { calls } = mockApi({
      "GET /session": () => ({ authRequired: true, authenticated: signedIn }),
      "POST /session": (init: RequestInit | undefined) => {
        const { key } = JSON.parse(String(init?.body)) as { key: string };
        if (key !== "right")
          return {
            status: 401,
            body: { error: { code: "unauthorized", message: "wrong API key" } },
          };
        signedIn = true;
        return { status: 204, body: null };
      },
      "GET /audits": { audits: [] },
      "DELETE /session": () => {
        signedIn = false;
        return { status: 204, body: null };
      },
    });
    renderAt("/");
    const input = await screen.findByLabelText("API key");
    expect(screen.queryByText("No audits yet")).toBeNull();
    expect(calls.some((c) => c.path === "/audits")).toBe(false);

    await userEvent.type(input, "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That key is not right.");

    await userEvent.clear(input);
    await userEvent.type(input, "right");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("No audits yet")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("API key")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull());
  });

  it("comes back when the API answers 401 later", async () => {
    let signedIn = true;
    mockApi({
      "GET /session": () => ({ authRequired: true, authenticated: signedIn }),
      "GET /audits": () => {
        signedIn = false; // e.g. the server was restarted with another key
        return { status: 401, body: { error: { code: "unauthorized", message: "x" } } };
      },
    });
    renderAt("/");
    expect(await screen.findByLabelText("API key")).toBeInTheDocument();
  });

  it("shows the page when no key is needed (no sign-out button)", async () => {
    mockApi({ "GET /audits": { audits: [] } });
    renderAt("/");
    expect(await screen.findByText("No audits yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
