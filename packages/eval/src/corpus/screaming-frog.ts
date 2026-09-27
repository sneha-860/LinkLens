import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readExportDir } from "../e5-files.js";
import { EXPORT_FILES, parseExports } from "../e5-screaming-frog.js";
import { writeJsonAtomic } from "./manifest.js";

/** Imported Screaming Frog exports live in `<batch dir>/screaming-frog/<site id>/`. */
export const SCREAMING_FROG_DIR = "screaming-frog";
export const IMPORT_FILE = "import.json";

export interface ScreamingFrogImport {
  readonly site: string;
  readonly importedAt: string;
  /** The Screaming Frog version the exports came from, if given (--sf-version). */
  readonly screamingFrogVersion: string | null;
  readonly files: { readonly name: string; readonly rows: number; readonly sha256: string }[];
}

export const siteExportDir = (batchDir: string, site: string) =>
  join(batchDir, SCREAMING_FROG_DIR, site);

/**
 * Import a site's three exports from `from` (internal_all.csv, all_inlinks.csv,
 * orphan_pages.csv): each is parsed first (a file Screaming Frog did not write is refused), then
 * copied as is into the batch, with its row count and SHA-256 in import.json.
 */
export function importExports(
  batchDir: string,
  site: string,
  from: string,
  now: string,
  screamingFrogVersion: string | null = null,
): ScreamingFrogImport {
  const csvs = readExportDir(from);
  if (csvs.inlinks === undefined) throw new Error(`${from}: no all_inlinks.csv`);
  if (csvs.orphans === undefined) throw new Error(`${from}: no orphan_pages.csv`);
  const parsed = parseExports(csvs);
  const dest = siteExportDir(batchDir, site);
  mkdirSync(dest, { recursive: true });
  const names = new Map(readdirSync(from).map((n) => [n.toLowerCase(), n]));
  const rows = {
    internal: parsed.internal.length,
    inlinks: parsed.inlinks?.length ?? 0,
    orphans: parsed.orphans?.length ?? 0,
  };
  const files: { name: string; rows: number; sha256: string }[] = [];
  for (const key of ["internal", "inlinks", "orphans"] as const) {
    const source = EXPORT_FILES[key].map((o) => names.get(o)).find((n) => n !== undefined);
    if (source === undefined) throw new Error(`${from}: no ${EXPORT_FILES[key][0]}`);
    const target = EXPORT_FILES[key][0];
    copyFileSync(join(from, source), join(dest, target));
    files.push({
      name: target,
      rows: rows[key],
      sha256: createHash("sha256")
        .update(readFileSync(join(dest, target)))
        .digest("hex"),
    });
  }
  const record: ScreamingFrogImport = { site, importedAt: now, screamingFrogVersion, files };
  writeJsonAtomic(join(dest, IMPORT_FILE), record);
  return record;
}

export function readImport(batchDir: string, site: string): ScreamingFrogImport | null {
  const path = join(siteExportDir(batchDir, site), IMPORT_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ScreamingFrogImport) : null;
}
