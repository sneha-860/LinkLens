import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlindItem, RatingResponse, RatingSummary } from "../../api/types.js";
import { audit, mockApi, renderAt } from "../../test/utils.js";

beforeEach(() => {
  vi.stubGlobal("EventSource", undefined);
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const S = "https://example.com";
const items: BlindItem[] = [
  {
    itemId: `add-link:${S}/a->${S}/b`,
    position: 1,
    donor: `${S}/a`,
    target: `${S}/b`,
    donorTitle: "Ocean guide",
    targetTitle: "Turtle nesting",
    action: "add-link",
    placement: {
      status: "suggested",
      paragraphIndex: 1,
      paragraphs: 3,
      ref: 0.83,
      term: "turtl nest",
      weight: 2,
      share: 0.5,
      anchor: "Turtle Nesting",
      excerpt: { text: "Volunteers guard Turtle Nesting beaches.", anchorStart: 17, anchorEnd: 31 },
      matched: [],
    },
  },
  {
    itemId: `make-visible:${S}/c->${S}/d`,
    position: 2,
    donor: `${S}/c`,
    target: `${S}/d`,
    donorTitle: null,
    targetTitle: "Coral reefs",
    action: "make-visible",
    placement: null,
  },
];
const sample: RatingResponse = {
  sample: {
    id: 41,
    version: "rating@1.0.0",
    size: 2,
    pool: 2,
    sigmaVariant: "refGateCosine",
    items,
  },
  canCreate: false,
  rater: null,
  name: null,
  answers: {},
};

describe("Rating tab", () => {
  it("draws the sample when there is none", async () => {
    let drawn = false;
    const { calls } = mockApi({
      "GET /audits/7": audit(),
      "GET /audits/7/rating": () => (drawn ? sample : { sample: null, canCreate: true }),
      "POST /audits/7/rating/sample": () => {
        drawn = true;
        return sample;
      },
    });
    renderAt("/audits/7/rating");
    await userEvent.click(await screen.findByRole("button", { name: "Draw the rating sample" }));
    expect(calls.some((c) => c.method === "POST" && c.path === "/audits/7/rating/sample")).toBe(
      true,
    );
    expect(
      await screen.findByText(/2 recommendations, in random order, without scores/),
    ).toBeInTheDocument();
  });

  it("shows items blind and saves a rater's answers", async () => {
    const { calls } = mockApi({
      "GET /audits/7": audit(),
      "GET /audits/7/rating": sample,
      "POST /audits/7/rating/answers": (init: RequestInit | undefined) =>
        JSON.parse(String(init?.body)),
    });
    renderAt("/audits/7/rating");
    expect(
      await screen.findByText("Choose your rater slot and enter your name to start."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Rater B"));
    await userEvent.type(screen.getByPlaceholderText("Your name"), "Ben");
    // The rater's own answers are asked for, never the other's.
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/audits/7/rating" && c.search === "?rater=B")).toBe(
        true,
      ),
    );

    const first = (await screen.findByRole("region", { name: "Recommendation 1" })) as HTMLElement;
    expect(first).toHaveTextContent("Ocean guide");
    expect(first).toHaveTextContent("Turtle nesting");
    expect(within(first).getByText("Turtle Nesting", { selector: "mark" })).toBeInTheDocument();
    // Blind: no score of any kind.
    expect(first).not.toHaveTextContent(/REF|0\.83|score|ΔPR/);

    // Relevant, then the placement: saved once both are chosen.
    await userEvent.click(within(first).getByLabelText("Relevant"));
    expect(calls.filter((c) => c.path === "/audits/7/rating/answers")).toHaveLength(0);
    await userEvent.click(within(first).getByLabelText("Acceptable"));
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.path === "/audits/7/rating/answers")
          .map((c) => JSON.parse(String(c.body))),
      ).toEqual([
        {
          relevant: true,
          placement: "acceptable",
          itemId: items[0]?.itemId,
          rater: "B",
          name: "Ben",
        },
      ]),
    );
    expect(await within(first).findByText("Saved")).toBeInTheDocument();

    // Not relevant saves at once with placement n/a; the placement choices are disabled.
    const second = screen.getByRole("region", { name: "Recommendation 2" });
    expect(second).toHaveTextContent("No placement was suggested.");
    await userEvent.click(within(second).getByLabelText("Not relevant"));
    await waitFor(() =>
      expect(
        JSON.parse(String(calls.filter((c) => c.path === "/audits/7/rating/answers").at(-1)?.body)),
      ).toMatchObject({
        itemId: items[1]?.itemId,
        relevant: false,
        placement: "na",
      }),
    );
    expect(within(second).getByLabelText("Good")).toBeDisabled();
    expect(screen.getByText("2 of 2 rated")).toBeInTheDocument();
  });

  it("shows precision@k and kappa only when the results are opened", async () => {
    const summary: RatingSummary = {
      version: "rating@1.0.0",
      items: 2,
      ks: [1, 2],
      raters: [
        {
          rater: "A",
          name: "Ana",
          rated: 2,
          relevant: 1,
          precisionAtK: [
            { k: 1, rated: 1, relevant: 1, precision: 1 },
            { k: 2, rated: 2, relevant: 1, precision: 0.5 },
          ],
          placement: { good: 1, acceptable: 0, poor: 0, na: 1 },
        },
        {
          rater: "B",
          name: "Ben",
          rated: 2,
          relevant: 2,
          precisionAtK: [
            { k: 1, rated: 1, relevant: 1, precision: 1 },
            { k: 2, rated: 2, relevant: 2, precision: 1 },
          ],
          placement: { good: 1, acceptable: 1, poor: 0, na: 0 },
        },
      ],
      consensus: {
        strict: [
          { k: 1, rated: 1, relevant: 1, precision: 1 },
          { k: 2, rated: 2, relevant: 1, precision: 0.5 },
        ],
        mean: [
          { k: 1, precision: 1 },
          { k: 2, precision: 0.75 },
        ],
      },
      agreement: {
        items: 2,
        relevance: { observed: 0.5, kappa: 0 },
        placement: { items: 1, observed: 1, kappa: null, weightedKappa: null },
      },
    };
    const { calls } = mockApi({
      "GET /audits/7": audit(),
      "GET /audits/7/rating": sample,
      "GET /audits/7/rating/summary": summary,
    });
    renderAt("/audits/7/rating");
    const toggle = await screen.findByText(/Show precision@k and agreement/);
    expect(calls.some((c) => c.path === "/audits/7/rating/summary")).toBe(false);
    await userEvent.click(toggle);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("row", { name: /Rater A \(Ana\)/ })).toHaveTextContent(
      "100% (1)50% (2)",
    );
    expect(within(table).getByRole("row", { name: /Mean of the two/ })).toHaveTextContent("75%");
    expect(screen.getByText(/Cohen's κ 0\.00/)).toBeInTheDocument();
  });
});
