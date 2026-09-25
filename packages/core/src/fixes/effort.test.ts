import { describe, expect, it } from "vitest";
import type { PageLink, PageLinks } from "../prominence/weights.js";
import { donorEffort, effortByNode, templatePages } from "./effort.js";

let id = 0;
/** [region, signature | null] per link, in document order. */
const page = (node: string, links: [string | null, string | null][]): PageLinks => ({
  node,
  links: links.map(([domRegion, templateSignature], i): PageLink => ({
    observationId: ++id,
    domRegion,
    templateSignature,
    positionIndex: i,
    target: null,
  })),
});

// "menu" is the site-wide nav; "related" is a body block on three article pages; "intro" is one
// page's own paragraph of links.
const pages = [
  page("home", [
    ["nav", "menu"],
    ["main", "intro"],
    ["main", "intro"],
  ]),
  page("a1", [
    ["nav", "menu"],
    ["main", "article"],
    ["main", "related"],
    ["main", "related"],
  ]),
  page("a2", [
    ["nav", "menu"],
    ["main", "article"],
    ["main", "related"],
  ]),
  page("a3", [
    ["nav", "menu"],
    ["body", "related"],
  ]),
  page("bare", []),
  page("chrome-only", [
    ["footer", "foot"],
    ["aside", "side"],
  ]),
  page("unsigned", [
    ["main", null],
    [null, null],
  ]),
];
const effort = effortByNode(pages);

describe("κ(u)", () => {
  it("counts the distinct template signatures among body-region links", () => {
    expect(effort.get("home")?.kappa).toBe(1); // one block, two links
    expect(effort.get("a1")?.kappa).toBe(2); // "article" and "related"
    expect(effort.get("a3")?.kappa).toBe(1); // region "body" counts as body
  });

  it("ignores links outside the body (nav, footer, aside…)", () => {
    expect(effort.get("a2")?.templates.map((t) => t.signature)).not.toContain("menu");
    expect(effort.get("chrome-only")).toMatchObject({ kappa: 1, bodyLinks: 0, templates: [] });
  });

  it("is at least 1, including pages without body links or signatures", () => {
    expect(effort.get("bare")).toMatchObject({ kappa: 1, templateReach: 1, bodyLinks: 0 });
    // A missing region is body (the extractor's default), but unsigned links name no block.
    expect(effort.get("unsigned")).toMatchObject({ kappa: 1, bodyLinks: 2, templates: [] });
  });
});

describe("templateReach(u)", () => {
  it("counts the pages carrying each signature, in any region", () => {
    expect(Object.fromEntries(templatePages(pages))).toEqual({
      menu: 4,
      intro: 1,
      article: 2,
      related: 3,
      foot: 1,
      side: 1,
    });
  });

  it("is the widest of the donor's body blocks; 1 for a unique page body", () => {
    expect(effort.get("home")?.templateReach).toBe(1);
    expect(effort.get("a1")).toMatchObject({
      templateReach: 3,
      templates: [
        { signature: "related", pages: 3 },
        { signature: "article", pages: 2 },
      ],
    });
    expect(effort.get("a3")?.templateReach).toBe(3);
  });

  it("treats a signature unknown to the reach map as the page itself", () => {
    expect(donorEffort(page("x", [["main", "new"]]), new Map()).templateReach).toBe(1);
  });
});
