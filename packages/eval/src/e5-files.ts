import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_FILES, type ScreamingFrogCsvs } from "./e5-screaming-frog.js";

/**
 * Read a folder of Screaming Frog exports: internal_all.csv (required), all_inlinks.csv and
 * orphan_pages.csv (optional). File names are matched case-insensitively.
 */
export function readExportDir(dir: string): ScreamingFrogCsvs {
  if (!existsSync(dir)) throw new Error(`no folder ${dir}`);
  const names = new Map(readdirSync(dir).map((n) => [n.toLowerCase(), n]));
  const find = (options: readonly string[]) => {
    const hit = options.map((o) => names.get(o)).find((n) => n !== undefined);
    return hit === undefined ? undefined : readFileSync(join(dir, hit), "utf8");
  };
  const internal = find(EXPORT_FILES.internal);
  if (internal === undefined) throw new Error(`${dir}: no internal_all.csv`);
  const inlinks = find(EXPORT_FILES.inlinks);
  const orphans = find(EXPORT_FILES.orphans);
  return {
    internal,
    ...(inlinks === undefined ? {} : { inlinks }),
    ...(orphans === undefined ? {} : { orphans }),
  };
}
