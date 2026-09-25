import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixes, prominence } from "@linklens/core";
import { extractPage } from "./extract.js";

// κ(u) and templateReach(u) on the crawler's fixture site, with links extracted by the real
// extractor (regions and template signatures as the crawler stores them).
const ROOT = fileURLToPath(new URL("../test/fixtures/site/", import.meta.url));
const ORIGIN = "http://fixture.test/";

function htmlFiles(dir: string, acc: string[] = []): string[] {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) htmlFiles(p, acc);
    else if (f.endsWith(".html")) acc.push(p);
  }
  return acc;
}

let id = 0;
const pages: prominence.PageLinks[] = htmlFiles(ROOT).map((file) => {
  const path = file.slice(ROOT.length).split("\\").join("/");
  const extracted = extractPage(readFileSync(file, "utf8"), ORIGIN + path);
  return {
    node: path,
    links: extracted.links.map((l) => ({
      observationId: ++id,
      domRegion: l.domRegion,
      templateSignature: l.templateSignature,
      positionIndex: l.positionIndex,
      target: null,
    })),
  };
});
const effort = fixes.effortByNode(pages);
const of = (path: string) => {
  const e = effort.get(path);
  if (e === undefined) throw new Error(`no fixture page ${path}`);
  return e;
};

describe("κ(u) on the fixture site", () => {
  it("is 1 for a page whose body links form one block", () => {
    // about.html: one link in div#content; the masthead, menu, aside and footer are not body.
    expect(of("about.html")).toMatchObject({ kappa: 1, bodyLinks: 1 });
    // index.html: sixteen links, all in one <main><ul> list; header nav and footer excluded.
    expect(of("index.html")).toMatchObject({ kappa: 1, bodyLinks: 16 });
  });

  it("counts each distinct body block", () => {
    // blog/index.html: the article list (two links, one block) and a separate paragraph link;
    // its breadcrumb and pagination links are not body.
    expect(of("blog/index.html")).toMatchObject({ kappa: 2, bodyLinks: 3 });
    // blog/post-1.html: the article footer link and "Back to blog"; "Next post" (rel=next) is
    // pagination, and the header nav, breadcrumb, aside and footer are chrome.
    expect(of("blog/post-1.html")).toMatchObject({ kappa: 2, bodyLinks: 2 });
  });

  it("is 1 for pages with no links at all", () => {
    expect(of("too-deep.html")).toMatchObject({ kappa: 1, templateReach: 1, bodyLinks: 0 });
    expect(of("html-only.html").kappa).toBe(1);
  });
});

describe("templateReach(u) on the fixture site", () => {
  it("finds the <main><ul> link list shared by the home page and both sitemap pages", () => {
    const home = of("index.html");
    expect(home.templateReach).toBe(3);
    expect(of("sitemap.html").templates[0]).toEqual(home.templates[0]);
    expect(of("site-map/index.html").templates[0]).toEqual(home.templates[0]);
  });

  it("is 1 for body blocks no other page has", () => {
    expect(of("about.html").templateReach).toBe(1);
    expect(of("blog/post-1.html").templates.map((t) => t.pages)).toEqual([1, 1]);
  });

  it("counts every page with a link directly under <body> as sharing one signature", () => {
    // A bare <body><a> has an empty ancestor chain, so its signature is the same on every such
    // page: the six deep pages, post-2, moved, nofollow-page and orphan. They are unrelated
    // pages, not a shared template (a limitation of structure-only signatures).
    expect(of("deep/3.html")).toMatchObject({ kappa: 1, templateReach: 10 });
    expect(of("blog/post-2.html").templateReach).toBe(10);
  });
});
