import { prominence, stats } from "@linklens/core";

/** One row of a Screaming Frog "Internal: All" export (internal_all.csv). */
export interface ScreamingFrogRow {
  readonly address: string;
  readonly statusCode: number | null;
  readonly contentType: string | null;
  readonly crawlDepth: number | null;
  readonly uniqueInlinks: number | null;
  readonly indexability: string | null;
}

const num = (s: string | undefined) => {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse a Screaming Frog "Internal: All" CSV. Columns are found by name (case-insensitive):
 * Address, Status Code, Content Type (or Content), Crawl Depth, Unique Inlinks, Indexability.
 * Screaming Frog sometimes writes a title line before the header; it is skipped.
 */
export function parseScreamingFrog(csv: string): ScreamingFrogRow[] {
  const records = prominence.parseCsv(csv);
  const headerAt = records.findIndex((r) =>
    r.fields.some((f) => f.trim().toLowerCase() === "address"),
  );
  if (headerAt < 0) throw new Error("not a Screaming Frog export: no Address column");
  const names = (records[headerAt] as prominence.CsvRecord).fields.map((f) =>
    f.trim().toLowerCase(),
  );
  const col = (...options: string[]) =>
    options.map((o) => names.indexOf(o)).find((i) => i >= 0) ?? -1;
  const at = {
    address: col("address"),
    status: col("status code"),
    type: col("content type", "content"),
    depth: col("crawl depth"),
    inlinks: col("unique inlinks"),
    indexability: col("indexability"),
  };
  const get = (fields: string[], i: number) => (i < 0 ? undefined : fields[i]);
  return records
    .slice(headerAt + 1)
    .map(({ fields }) => ({
      address: (get(fields, at.address) ?? "").trim(),
      statusCode: num(get(fields, at.status)),
      contentType: get(fields, at.type)?.trim() || null,
      crawlDepth: num(get(fields, at.depth)),
      uniqueInlinks: num(get(fields, at.inlinks)),
      indexability: get(fields, at.indexability)?.trim() || null,
    }))
    .filter((r) => r.address !== "");
}

/** A page as LinkLens saw it (a crawled node of the link graph). */
export interface OurPage {
  readonly url: string;
  readonly depth: number | null;
  /** Distinct pages linking to it (Screaming Frog's "Unique Inlinks"). */
  readonly inNeighbours: number;
}

export interface Calibration {
  readonly ours: number;
  readonly screamingFrog: number;
  readonly common: number;
  readonly coverageJaccard: number;
  readonly onlyOurs: string[];
  readonly onlyScreamingFrog: string[];
  readonly depth: {
    readonly pages: number;
    readonly exact: number;
    readonly withinOne: number;
    readonly spearman: number | null;
  };
  readonly inlinksSpearman: number | null;
}

/**
 * E5: compare LinkLens with Screaming Frog on the HTML pages both crawled (status 200,
 * text/html), URLs matched after `key` (e.g. P3 canonicalisation). Coverage (Jaccard, and the
 * pages only one tool found), click depth agreement (exact, within one, Spearman) and the
 * Spearman correlation of unique inlinks.
 */
export function calibrate(
  ours: readonly OurPage[],
  sf: readonly ScreamingFrogRow[],
  key: (url: string) => string,
): Calibration {
  const mine = new Map<string, OurPage>();
  for (const p of ours) {
    const k = key(p.url);
    const prev = mine.get(k);
    if (prev === undefined || (p.depth ?? Infinity) < (prev.depth ?? Infinity)) mine.set(k, p);
  }
  const theirs = new Map<string, ScreamingFrogRow>();
  for (const r of sf) {
    if (r.statusCode !== 200 || !(r.contentType ?? "text/html").toLowerCase().includes("html"))
      continue;
    let k: string;
    try {
      k = key(r.address);
    } catch {
      continue;
    }
    if (!theirs.has(k)) theirs.set(k, r);
  }
  const common = [...mine.keys()].filter((k) => theirs.has(k)).sort();
  const depthPairs = common
    .map((k) => [mine.get(k)?.depth ?? null, theirs.get(k)?.crawlDepth ?? null] as const)
    .filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null);
  const toMap = (pairs: readonly (readonly [string, number])[]) => new Map(pairs);
  return {
    ours: mine.size,
    screamingFrog: theirs.size,
    common: common.length,
    coverageJaccard: stats.jaccard(new Set(mine.keys()), new Set(theirs.keys())),
    onlyOurs: [...mine.keys()].filter((k) => !theirs.has(k)).sort(),
    onlyScreamingFrog: [...theirs.keys()].filter((k) => !mine.has(k)).sort(),
    depth: {
      pages: depthPairs.length,
      exact:
        depthPairs.length === 0
          ? 0
          : depthPairs.filter(([a, b]) => a === b).length / depthPairs.length,
      withinOne:
        depthPairs.length === 0
          ? 0
          : depthPairs.filter(([a, b]) => Math.abs(a - b) <= 1).length / depthPairs.length,
      spearman: stats.spearman(
        toMap(
          common
            .filter((k) => mine.get(k)?.depth != null && theirs.get(k)?.crawlDepth != null)
            .map((k) => [k, mine.get(k)?.depth as number]),
        ),
        toMap(
          common
            .filter((k) => mine.get(k)?.depth != null && theirs.get(k)?.crawlDepth != null)
            .map((k) => [k, theirs.get(k)?.crawlDepth as number]),
        ),
      ),
    },
    inlinksSpearman: stats.spearman(
      toMap(
        common
          .filter((k) => theirs.get(k)?.uniqueInlinks != null)
          .map((k) => [k, mine.get(k)?.inNeighbours ?? 0]),
      ),
      toMap(
        common
          .filter((k) => theirs.get(k)?.uniqueInlinks != null)
          .map((k) => [k, theirs.get(k)?.uniqueInlinks as number]),
      ),
    ),
  };
}
