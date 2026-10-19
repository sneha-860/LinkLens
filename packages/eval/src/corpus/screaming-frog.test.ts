import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExportDir } from "../e5-files.js";
import { parseExports } from "../e5-screaming-frog.js";
import { importExports, readImport, siteExportDir } from "./screaming-frog.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "linklens-sf-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INTERNAL = "Address,Status Code,Content Type,Crawl Depth\nhttps://s.test/,200,text/html,0\n";
const INLINKS = "Type,Source,Destination\nHyperlink,https://s.test/,https://s.test/a\n";
const ORPHANS = "Address\nhttps://s.test/o\n";

function exportsDir(files: Record<string, string>): string {
  const d = tmp();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}

describe("importExports", () => {
  it("parses, copies and records the three exports with their hashes", () => {
    const batch = tmp();
    const from = exportsDir({
      "Internal_All.csv": INTERNAL,
      "all_inlinks.csv": INLINKS,
      "orphan_pages.csv": ORPHANS,
    });
    const r = importExports(batch, "site", from, "2026-01-01T00:00:00.000Z", "21.0");
    expect(r).toMatchObject({ site: "site", screamingFrogVersion: "21.0", orphans: "imported" });
    expect(r.files.map((f) => [f.name, f.rows])).toEqual([
      ["internal_all.csv", 1],
      ["all_inlinks.csv", 1],
      ["orphan_pages.csv", 1],
    ]);
    expect(r.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(readdirSync(siteExportDir(batch, "site")).sort()).toEqual([
      "all_inlinks.csv",
      "import.json",
      "internal_all.csv",
      "orphan_pages.csv",
    ]);
    expect(readImport(batch, "site")).toEqual(r);
    expect(readImport(batch, "other")).toBeNull();
  });

  it("refuses a missing or foreign export, copying nothing", () => {
    const batch = tmp();
    expect(() =>
      importExports(
        batch,
        "s",
        exportsDir({ "internal_all.csv": INTERNAL, "all_inlinks.csv": INLINKS }),
        "t",
      ),
    ).toThrow(/orphan_pages/);
    expect(() =>
      importExports(
        batch,
        "s",
        exportsDir({
          "internal_all.csv": "Foo\n1",
          "all_inlinks.csv": INLINKS,
          "orphan_pages.csv": ORPHANS,
        }),
        "t",
      ),
    ).toThrow(/Internal: All/);
    expect(readImport(batch, "s")).toBeNull();
  });

  it("records the orphan report as imported, even when it has no rows", () => {
    const batch = tmp();
    const from = exportsDir({
      "internal_all.csv": INTERNAL,
      "all_inlinks.csv": INLINKS,
      "orphan_pages.csv": "Address\n",
    });
    const r = importExports(batch, "s", from, "t");
    expect(r.orphans).toBe("imported");
    expect(r.files.map((f) => [f.name, f.rows])).toContainEqual(["orphan_pages.csv", 0]);
  });

  it("skips the orphan report with orphans: skip, present or not", () => {
    const batch = tmp();
    const full = exportsDir({
      "internal_all.csv": INTERNAL,
      "all_inlinks.csv": INLINKS,
      "orphan_pages.csv": ORPHANS,
    });
    // An earlier import copied the report; skipping it now removes the copy.
    importExports(batch, "s", full, "t");
    const r = importExports(batch, "s", full, "t2", "24.3", "skip");
    expect(r).toMatchObject({ screamingFrogVersion: "24.3", orphans: "skipped" });
    expect(r.files.map((f) => f.name)).toEqual(["internal_all.csv", "all_inlinks.csv"]);
    expect(readdirSync(siteExportDir(batch, "s")).sort()).toEqual([
      "all_inlinks.csv",
      "import.json",
      "internal_all.csv",
    ]);
    expect(readImport(batch, "s")).toEqual(r);
    const without = exportsDir({ "internal_all.csv": INTERNAL, "all_inlinks.csv": INLINKS });
    expect(importExports(batch, "s2", without, "t", null, "skip").orphans).toBe("skipped");
    // E5 then reads no orphan report: no orphan comparison.
    expect(parseExports(readExportDir(siteExportDir(batch, "s"))).orphans).toBeNull();
  });
});
