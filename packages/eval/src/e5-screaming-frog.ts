import {
  canonicalise,
  db as q,
  discovery,
  graph,
  prominence,
  stats,
  type LinkLensConfig,
} from "@linklens/core";
import type { RunInputs } from "./in-memory.js";

type PolicyId = canonicalise.PolicyId;

// ---------- the three Screaming Frog exports ----------

/** One row of a Screaming Frog "Internal: All" export (internal_all.csv). */
export interface ScreamingFrogRow {
  readonly address: string;
  readonly statusCode: number | null;
  readonly contentType: string | null;
  readonly crawlDepth: number | null;
  readonly uniqueInlinks: number | null;
  readonly indexability: string | null;
}

/** One row of "Bulk Export → Links → All Inlinks" (all_inlinks.csv). */
export interface ScreamingFrogLink {
  /** Hyperlink, JavaScript, Canonical, HREF Lang, Rel Next, Image, Redirect, … */
  readonly type: string;
  readonly source: string;
  readonly destination: string;
  /** "Follow" column: false for nofollow; null when absent. */
  readonly follow: boolean | null;
  readonly linkPosition: string | null;
}

/** One row of "Reports → Orphan Pages" (orphan_pages.csv). */
export interface ScreamingFrogOrphan {
  readonly address: string;
  /** Where Screaming Frog found it: Sitemap, Google Analytics, Search Console, … (if given). */
  readonly source: string | null;
}

export interface ScreamingFrogExport {
  readonly internal: readonly ScreamingFrogRow[];
  /** null: no All Inlinks export (inlinks are then only SF's own column; depth is not explained). */
  readonly inlinks: readonly ScreamingFrogLink[] | null;
  /** null: no Orphan pages export (no orphan comparison). */
  readonly orphans: readonly ScreamingFrogOrphan[] | null;
}

const num = (s: string | undefined) => {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * A Screaming Frog CSV as records by column name (case-insensitive). Screaming Frog sometimes
 * writes a title line ("Internal - All") before the header: the header is the first line that
 * has `required`.
 */
function sfTable(csv: string, required: string, what: string) {
  const records = prominence.parseCsv(csv);
  const headerAt = records.findIndex((r) =>
    r.fields.some((f) => f.trim().toLowerCase() === required),
  );
  if (headerAt < 0) throw new Error(`not a Screaming Frog ${what} export: no ${required} column`);
  const names = (records[headerAt] as prominence.CsvRecord).fields.map((f) =>
    f.trim().toLowerCase(),
  );
  const col = (...options: string[]) =>
    options.map((o) => names.indexOf(o)).find((i) => i >= 0) ?? -1;
  const rows = records.slice(headerAt + 1).map((r) => r.fields);
  const get = (fields: string[], i: number) => (i < 0 ? undefined : fields[i]?.trim());
  return { col, rows, get };
}

/** Parse "Internal: All". Columns by name: Address, Status Code, Content Type, Crawl Depth,
 * Unique Inlinks, Indexability. */
export function parseScreamingFrog(csv: string): ScreamingFrogRow[] {
  const { col, rows, get } = sfTable(csv, "address", "Internal: All");
  const at = {
    address: col("address"),
    status: col("status code"),
    type: col("content type", "content"),
    depth: col("crawl depth"),
    inlinks: col("unique inlinks"),
    indexability: col("indexability"),
  };
  return rows
    .map((f) => ({
      address: get(f, at.address) ?? "",
      statusCode: num(get(f, at.status)),
      contentType: get(f, at.type) || null,
      crawlDepth: num(get(f, at.depth)),
      uniqueInlinks: num(get(f, at.inlinks)),
      indexability: get(f, at.indexability) || null,
    }))
    .filter((r) => r.address !== "");
}

/** Parse "All Inlinks". Columns by name: Type, Source, Destination, Follow, Link Position. */
export function parseAllInlinks(csv: string): ScreamingFrogLink[] {
  const { col, rows, get } = sfTable(csv, "destination", "All Inlinks");
  const at = {
    type: col("type"),
    source: col("source"),
    destination: col("destination"),
    follow: col("follow"),
    position: col("link position"),
  };
  if (at.source < 0) throw new Error("not a Screaming Frog All Inlinks export: no Source column");
  return rows
    .map((f) => {
      const follow = get(f, at.follow)?.toLowerCase();
      return {
        type: get(f, at.type) || "Hyperlink",
        source: get(f, at.source) ?? "",
        destination: get(f, at.destination) ?? "",
        follow: follow === "true" ? true : follow === "false" ? false : null,
        linkPosition: get(f, at.position) || null,
      };
    })
    .filter((r) => r.source !== "" && r.destination !== "");
}

/** Parse "Orphan Pages". Columns by name: Address (or URL), and a source column if present. */
export function parseOrphanPages(csv: string): ScreamingFrogOrphan[] {
  const records = prominence.parseCsv(csv);
  const required = records.some((r) => r.fields.some((f) => f.trim().toLowerCase() === "address"))
    ? "address"
    : "url";
  const { col, rows, get } = sfTable(csv, required, "Orphan Pages");
  const at = { address: col("address", "url"), source: col("source", "orphan source", "found in") };
  return rows
    .map((f) => ({ address: get(f, at.address) ?? "", source: get(f, at.source) || null }))
    .filter((r) => r.address !== "");
}

/** The exports as CSV text (as read from files). */
export interface ScreamingFrogCsvs {
  readonly internal: string;
  readonly inlinks?: string;
  readonly orphans?: string;
}

export function parseExports(csvs: ScreamingFrogCsvs): ScreamingFrogExport {
  return {
    internal: parseScreamingFrog(csvs.internal),
    inlinks: csvs.inlinks === undefined ? null : parseAllInlinks(csvs.inlinks),
    orphans: csvs.orphans === undefined ? null : parseOrphanPages(csvs.orphans),
  };
}

/** The file names the exports are looked for under (case-insensitive), in order. */
export const EXPORT_FILES = {
  internal: ["internal_all.csv"],
  inlinks: ["all_inlinks.csv"],
  orphans: ["orphan_pages.csv", "orphan_urls.csv"],
} as const;

// ---------- disagreement categories ----------

export const DISAGREEMENT_KINDS = [
  "url-only-screaming-frog",
  "url-only-linklens",
  "depth",
  "inlinks",
  "orphan-only-screaming-frog",
  "orphan-only-linklens",
] as const;
export type DisagreementKind = (typeof DISAGREEMENT_KINDS)[number];

/**
 * What each category means, quoted in the output. `{policy}`, `{types}` and `{channels}` are
 * filled per category from its evidence. Rules are tried in the order listed per kind.
 */
export const EXPLANATIONS: Readonly<Record<DisagreementKind, Readonly<Record<string, string>>>> = {
  "url-only-screaming-frog": {
    normalisation:
      "The URLs differ only in form (case, trailing slash, query order or tracking, protocol, www); they are one page under {policy}.",
    "out-of-scope":
      "Screaming Frog crawled a host LinkLens does not (a subdomain, or another host): LinkLens's scope is the seed's host.",
    "page-cap":
      "LinkLens found the link but stopped at its page cap (pageCap) before fetching the page.",
    "robots-linklens":
      "robots.txt disallows LinkLensBot (or its Crawl-delay is too long): LinkLens obeys it, Screaming Frog ignored it or matched another group.",
    "status-linklens":
      "LinkLens got another answer (a redirect, an error, or not HTML) than Screaming Frog's 200 HTML.",
    "not-fetched":
      "LinkLens found the link but did not fetch the page (not admitted: nofollow when followNofollow is off, or the crawl ended).",
    "link-not-extracted":
      "Screaming Frog reached it through links LinkLens does not extract from pages both crawled ({types}); LinkLens reads <a href> in the HTML only, without rendering JavaScript.",
    "sf-non-link":
      "Screaming Frog has no link to it: it came from a sitemap, list mode or analytics, not from a crawl of links.",
    "sources-not-crawled-linklens":
      "The pages linking to it were not crawled by LinkLens (its cap, failures or robots.txt), so it was never reached.",
  },
  "url-only-linklens": {
    normalisation:
      "The URLs differ only in form (case, trailing slash, query, protocol, www); they are one page under {policy}.",
    "status-screaming-frog":
      "Screaming Frog recorded another status or content type for it (not 200 HTML): the site answered differently, or at another time.",
    nofollow:
      "Every link LinkLens has to it is rel=nofollow: LinkLens follows nofollow links (followNofollow), Screaming Frog does not by default.",
    "link-not-in-screaming-frog":
      "LinkLens extracted links to it from pages Screaming Frog crawled, but Screaming Frog recorded none (links it does not store, or a different answer for those pages).",
    "sources-not-crawled-screaming-frog":
      "The pages linking to it were not crawled by Screaming Frog (its crawl limits or configuration).",
    "not-in-screaming-frog":
      "Screaming Frog does not list it at all (a crawl limit, an exclusion, or the page appeared between the two crawls).",
  },
  depth: {
    "seed-differs":
      "The two crawls started from different pages, so every depth is counted from another origin.",
    "redirect-hop":
      "Screaming Frog reached it through a redirect, which it counts as one more level; LinkLens counts clicks between pages.",
    "link-not-extracted":
      "Screaming Frog has a shorter path through a link LinkLens does not extract ({types}).",
    "parent-not-crawled-linklens":
      "Screaming Frog's shorter path goes through a page LinkLens did not crawl.",
    "nofollow-path":
      "LinkLens's shorter path uses a rel=nofollow link, which Screaming Frog does not follow by default.",
    "link-not-in-screaming-frog":
      "LinkLens has a shorter path through a link Screaming Frog did not record.",
    "parent-not-crawled-screaming-frog":
      "LinkLens's shorter path goes through a page Screaming Frog did not crawl.",
    cascade:
      "The page's parent on the shorter path is itself at another depth in the other tool: the difference is inherited.",
    other: "No single link explains the difference (several paths of equal length differ).",
  },
  inlinks: {
    "sources-not-crawled-linklens":
      "Most of the missing linking pages were not crawled by LinkLens (its cap, failures or robots.txt).",
    "link-not-extracted":
      "Most of the missing links come from pages both crawled: links LinkLens does not extract ({types}).",
    "sources-not-crawled-screaming-frog":
      "Most of the extra linking pages were not crawled by Screaming Frog.",
    "link-not-in-screaming-frog":
      "Most of the extra links come from pages Screaming Frog crawled but did not record (nofollow, or links it does not store).",
  },
  "orphan-only-screaming-frog": {
    "reachable-linklens":
      "LinkLens reaches it by links, so it is not an orphan there: a link Screaming Frog did not see or follow.",
    "not-in-linklens-channels":
      "Only Screaming Frog's orphan sources list it ({sources}): none of LinkLens's six channels (link graph, XML sitemap, robots.txt Sitemap, HTML sitemap, RSS/Atom, llms.txt) did — e.g. Google Analytics or Search Console, or a sitemap LinkLens did not find.",
    "not-crawled-linklens":
      "LinkLens knows it from a channel but did not crawl the site deep enough to judge it (its page cap).",
  },
  "orphan-only-linklens": {
    "reachable-screaming-frog":
      "Screaming Frog has links to it, so it is not an orphan there: links LinkLens does not extract, or pages LinkLens did not crawl.",
    "channel-screaming-frog-does-not-read":
      "LinkLens found it only through channels Screaming Frog's orphan report does not read ({channels}).",
    "not-in-screaming-frog-orphans":
      "Screaming Frog's orphan report does not list it (its orphan analysis needs the sitemap, Google Analytics or Search Console connected).",
  },
};

export interface Disagreement {
  readonly kind: DisagreementKind;
  /** The page (node id under the policy). */
  readonly node: string;
  readonly category: string;
  /** Evidence: link types, statuses, channels, sources, depths… */
  readonly detail: Readonly<Record<string, string | number | null>>;
}

export interface CategorySummary {
  readonly kind: DisagreementKind;
  readonly category: string;
  readonly count: number;
  /** Of this kind's disagreements. */
  readonly share: number;
  readonly large: boolean;
  readonly explanation: string;
  readonly examples: string[];
}

export interface PolicyCalibration {
  readonly policy: PolicyId;
  readonly policyVersion: string;
  readonly urls: {
    readonly linklens: number;
    readonly screamingFrog: number;
    readonly common: number;
    readonly jaccard: number;
  };
  readonly inlinks: {
    readonly pages: number;
    /** vs inlinks recomputed from All Inlinks under the same policy (null without it). */
    readonly spearman: number | null;
    /** vs Screaming Frog's own "Unique Inlinks" column (per its URL). */
    readonly spearmanColumn: number | null;
    readonly largeDifferences: number;
  };
  readonly depth: {
    readonly pages: number;
    readonly exact: number | null;
    readonly withinOne: number | null;
    readonly spearman: number | null;
    readonly meanAbsDifference: number | null;
    readonly seedDiffers: boolean;
  };
  readonly orphans: {
    readonly linklens: number;
    readonly screamingFrog: number | null;
    readonly common: number | null;
    readonly jaccard: number | null;
  };
  readonly categories: CategorySummary[];
  readonly disagreements: Disagreement[];
}

export interface Calibration {
  readonly runId: number;
  readonly policies: PolicyCalibration[];
}

// ---------- the calibration ----------

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isHtml200 = (r: ScreamingFrogRow) =>
  r.statusCode === 200 && (r.contentType ?? "text/html").toLowerCase().includes("html");
const hyperlink = (l: ScreamingFrogLink) => l.type.toLowerCase() === "hyperlink";

/** One tool's view of a site under one policy, keyed by node id. */
interface View {
  readonly crawled: Set<string>;
  readonly depth: Map<string, number>;
  /** node → linking nodes (self-loops dropped), and the links' nofollow flags. */
  readonly sources: Map<string, Set<string>>;
  readonly nofollowOnly: Set<string>;
}

function ourView(
  inputs: RunInputs,
  policyId: PolicyId,
): View & { graph: graph.LinkGraph; seed: string } {
  const derived = graph.deriveGraphFromObservations(
    inputs.observations,
    policyId,
    inputs.context,
    inputs.config,
  );
  const g = derived.graph;
  const crawled = new Set<string>();
  const depth = new Map<string, number>();
  g.forEachNode((n, a) => {
    if (a.crawled) crawled.add(n);
    if (a.depth !== null && a.depth !== undefined) depth.set(n, a.depth);
  });
  const sources = new Map<string, Set<string>>();
  const follow = new Map<string, boolean>();
  g.forEachEdge((_e, a, s, t) => {
    if (s === t) return;
    const set = sources.get(t) ?? new Set<string>();
    set.add(s);
    sources.set(t, set);
    const nofollow = /\bnofollow\b/i.test(a.rel ?? "");
    follow.set(t, (follow.get(t) ?? false) || !nofollow);
  });
  const nofollowOnly = new Set([...follow].filter(([, f]) => !f).map(([t]) => t));
  return { crawled, depth, sources, nofollowOnly, graph: g, seed: derived.summary.seedNode };
}

function sfView(
  sf: ScreamingFrogExport,
  key: (url: string) => string | null,
): View & {
  row: Map<string, ScreamingFrogRow>;
  linkTypes: Map<string, Set<string>>;
  seed: string | null;
  column: Map<string, number>;
  edges: Set<string>;
} {
  const crawled = new Set<string>();
  const depth = new Map<string, number>();
  const row = new Map<string, ScreamingFrogRow>();
  const column = new Map<string, number>();
  let seed: string | null = null;
  for (const r of sf.internal) {
    const k = key(r.address);
    if (k === null) continue;
    if (!row.has(k) || isHtml200(r)) row.set(k, r);
    if (!isHtml200(r)) continue;
    crawled.add(k);
    if (r.crawlDepth !== null) {
      depth.set(k, Math.min(depth.get(k) ?? Infinity, r.crawlDepth));
      if (r.crawlDepth === 0) seed = k;
    }
    if (r.uniqueInlinks !== null && !column.has(k)) column.set(k, r.uniqueInlinks);
  }
  const sources = new Map<string, Set<string>>();
  const linkTypes = new Map<string, Set<string>>();
  const edges = new Set<string>();
  const follow = new Map<string, boolean>();
  for (const l of sf.inlinks ?? []) {
    const s = key(l.source);
    const t = key(l.destination);
    if (s === null || t === null || s === t) continue;
    const types = linkTypes.get(t) ?? new Set<string>();
    types.add(l.type);
    linkTypes.set(t, types);
    if (!hyperlink(l)) continue;
    const set = sources.get(t) ?? new Set<string>();
    set.add(s);
    sources.set(t, set);
    edges.add(`${s} -> ${t}`);
    follow.set(t, (follow.get(t) ?? false) || l.follow !== false);
  }
  const nofollowOnly = new Set([...follow].filter(([, f]) => !f).map(([t]) => t));
  return { crawled, depth, sources, nofollowOnly, row, linkTypes, seed, column, edges };
}

/** Latest crawl fetch per node under the policy. */
function ourFetches(
  inputs: RunInputs,
  key: (url: string) => string | null,
): Map<string, q.FetchRow> {
  const out = new Map<string, q.FetchRow>();
  for (const f of [...inputs.fetches].sort((a, b) => a.attempt - b.attempt || a.id - b.id)) {
    const k = key(f.requestedUrl);
    if (k !== null) out.set(k, f);
  }
  return out;
}

const typesOf = (types: Set<string> | undefined) =>
  [...(types ?? [])]
    .filter((t) => t.toLowerCase() !== "hyperlink")
    .sort()
    .join(", ") || "hyperlinks in markup LinkLens does not read";

/**
 * Pure (E5): LinkLens against Screaming Frog on one site, under each policy (P0 first, then the
 * audit's). Screaming Frog's URLs go through the same canonicaliser (and the run's redirect and
 * canonical context) as LinkLens's. Every disagreement gets a category by fixed rules, and the
 * categories are summarised with their explanation; a category is large when it holds at least
 * e5LargeShare of its kind and e5LargeMin disagreements.
 */
export function calibrateRun(
  inputs: RunInputs,
  sf: ScreamingFrogExport,
  policies: readonly PolicyId[],
  config: Pick<
    LinkLensConfig,
    | "e5LargeShare"
    | "e5LargeMin"
    | "e5InlinkMinAbsDiff"
    | "e5InlinkMinRelDiff"
    | "e5Examples"
    | "pageCap"
  >,
): Calibration {
  const isInternal = graph.makeInternalTest(
    inputs.observations.seedUrl,
    inputs.config.includeSubdomains,
  );
  const keyFor = (policyId: PolicyId) => (url: string) => {
    try {
      return canonicalise.POLICIES[policyId].canonicalise(url, inputs.context);
    } catch {
      return null;
    }
  };
  const coarsest = policies[policies.length - 1] as PolicyId;
  const coarse = { key: keyFor(coarsest), ours: ourView(inputs, coarsest) };
  const coarseSf = sfView(sf, coarse.key);
  const capReached = new Set(inputs.fetches.map((f) => f.requestedUrl)).size >= config.pageCap;

  // Reconciled orphans and their channels, per policy.
  const orphansOf = (policyId: PolicyId, ours: ReturnType<typeof ourView>) => {
    const reach = new Map<string, { reachable: boolean; depth: number | null }>();
    ours.graph.forEachNode((n, a) =>
      reach.set(n, { reachable: a.reachable === true, depth: a.depth ?? null }),
    );
    const rec =
      inputs.discovery.length === 0
        ? null
        : discovery.reconcile({
            runId: inputs.runId,
            policyVersion: canonicalise.POLICIES[policyId].version,
            observations: inputs.discovery,
            isInternal,
            canonicalise: (u) => canonicalise.POLICIES[policyId].canonicalise(u, inputs.context),
            graph: reach,
          });
    return rec;
  };

  const results = policies.map((policyId): PolicyCalibration => {
    const key = keyFor(policyId);
    const ours = policyId === coarsest ? coarse.ours : ourView(inputs, policyId);
    const theirs = policyId === coarsest ? coarseSf : sfView(sf, key);
    const fetches = ourFetches(inputs, key);
    const found: Disagreement[] = [];
    const add = (
      kind: DisagreementKind,
      node: string,
      category: string,
      detail: Disagreement["detail"] = {},
    ) => found.push({ kind, node, category, detail });
    // Only under a finer policy than the coarsest: do the two URLs meet there?
    const meetsCoarsely = (url: string, side: "ours" | "sf") => {
      if (policyId === coarsest) return false;
      const k = coarse.key(url);
      return k !== null && (side === "ours" ? coarse.ours.crawled : coarseSf.crawled).has(k);
    };
    const sfUrl = new Map<string, string>();
    for (const r of sf.internal) {
      const k = key(r.address);
      if (k !== null && !sfUrl.has(k)) sfUrl.set(k, r.address);
    }

    // URL sets.
    const common = [...ours.crawled].filter((k) => theirs.crawled.has(k)).sort();
    for (const v of [...theirs.crawled].filter((k) => !ours.crawled.has(k)).sort()) {
      const url = sfUrl.get(v) ?? v;
      const f = fetches.get(v);
      const sfSources = theirs.sources.get(v) ?? new Set<string>();
      if (meetsCoarsely(url, "ours"))
        add("url-only-screaming-frog", v, "normalisation", { policy: coarsest });
      else if (!isInternal(url)) add("url-only-screaming-frog", v, "out-of-scope");
      else if (f !== undefined && /blocked by robots\.txt|Crawl-delay/i.test(f.error ?? ""))
        add("url-only-screaming-frog", v, "robots-linklens", { error: f.error });
      else if (f !== undefined)
        add("url-only-screaming-frog", v, "status-linklens", {
          status: f.statusCode,
          contentType: f.contentType,
          error: f.error,
        });
      else if (ours.graph.hasNode(v))
        add("url-only-screaming-frog", v, capReached ? "page-cap" : "not-fetched");
      else if (sfSources.size === 0 && !(theirs.linkTypes.get(v)?.size ?? 0))
        add("url-only-screaming-frog", v, "sf-non-link");
      else if (
        [...sfSources].some((s) => ours.crawled.has(s)) ||
        ((theirs.linkTypes.get(v)?.size ?? 0) > 0 && sfSources.size === 0)
      )
        add("url-only-screaming-frog", v, "link-not-extracted", {
          types: typesOf(theirs.linkTypes.get(v)),
        });
      else add("url-only-screaming-frog", v, "sources-not-crawled-linklens");
    }
    for (const v of [...ours.crawled].filter((k) => !theirs.crawled.has(k)).sort()) {
      const ourSources = ours.sources.get(v) ?? new Set<string>();
      const r = theirs.row.get(v);
      if (meetsCoarsely(v, "sf"))
        add("url-only-linklens", v, "normalisation", { policy: coarsest });
      else if (r !== undefined)
        add("url-only-linklens", v, "status-screaming-frog", {
          status: r.statusCode,
          contentType: r.contentType,
          indexability: r.indexability,
        });
      else if (ours.nofollowOnly.has(v)) add("url-only-linklens", v, "nofollow");
      else if (sf.inlinks !== null && [...ourSources].some((s) => theirs.crawled.has(s)))
        add("url-only-linklens", v, "link-not-in-screaming-frog");
      else if (ourSources.size > 0 && ![...ourSources].some((s) => theirs.crawled.has(s)))
        add("url-only-linklens", v, "sources-not-crawled-screaming-frog");
      else add("url-only-linklens", v, "not-in-screaming-frog");
    }

    // Inlinks.
    const inlinkPairs = common.map((v) => ({
      v,
      ours: ours.sources.get(v)?.size ?? 0,
      sf: theirs.sources.get(v)?.size ?? 0,
    }));
    let largeInlinks = 0;
    if (sf.inlinks !== null) {
      for (const p of inlinkPairs) {
        const diff = Math.abs(p.ours - p.sf);
        if (
          diff < config.e5InlinkMinAbsDiff ||
          diff < config.e5InlinkMinRelDiff * Math.max(p.ours, p.sf)
        )
          continue;
        largeInlinks += 1;
        const o = ours.sources.get(p.v) ?? new Set<string>();
        const s = theirs.sources.get(p.v) ?? new Set<string>();
        const missing = [...s].filter((x) => !o.has(x));
        const extra = [...o].filter((x) => !s.has(x));
        const counts: Record<string, number> = {
          "sources-not-crawled-linklens": missing.filter((x) => !ours.crawled.has(x)).length,
          "link-not-extracted": missing.filter((x) => ours.crawled.has(x)).length,
          "sources-not-crawled-screaming-frog": extra.filter((x) => !theirs.crawled.has(x)).length,
          "link-not-in-screaming-frog": extra.filter((x) => theirs.crawled.has(x)).length,
        };
        const category = Object.entries(counts).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        add("inlinks", p.v, category, {
          linklens: p.ours,
          screamingFrog: p.sf,
          types: typesOf(theirs.linkTypes.get(p.v)),
        });
      }
    }

    // Depth.
    const seedDiffers = theirs.seed !== null && theirs.seed !== ours.seed;
    const depthPairs = common
      .filter((v) => ours.depth.has(v) && theirs.depth.has(v))
      .map((v) => ({ v, ours: ours.depth.get(v) as number, sf: theirs.depth.get(v) as number }));
    for (const p of depthPairs) {
      if (p.ours === p.sf) continue;
      const detail = { linklens: p.ours, screamingFrog: p.sf };
      if (seedDiffers) {
        add("depth", p.v, "seed-differs", detail);
      } else if (p.sf < p.ours) {
        if (sf.inlinks === null) {
          add("depth", p.v, "other", detail);
          continue;
        }
        const parents = [...(theirs.sources.get(p.v) ?? [])]
          .filter((u) => theirs.depth.get(u) === p.sf - 1)
          .sort();
        const types = theirs.linkTypes.get(p.v);
        if (parents.length === 0 && [...(types ?? [])].some((t) => /redirect/i.test(t)))
          add("depth", p.v, "redirect-hop", detail);
        else if (
          parents.some((u) => ours.crawled.has(u) && !(ours.sources.get(p.v)?.has(u) ?? false))
        )
          add("depth", p.v, "link-not-extracted", { ...detail, types: typesOf(types) });
        else if (parents.some((u) => !ours.crawled.has(u)))
          add("depth", p.v, "parent-not-crawled-linklens", detail);
        else if (parents.some((u) => (ours.depth.get(u) ?? Infinity) !== theirs.depth.get(u)))
          add("depth", p.v, "cascade", detail);
        else add("depth", p.v, "other", detail);
      } else {
        const parents = [...(ours.sources.get(p.v) ?? [])]
          .filter((u) => ours.depth.get(u) === p.ours - 1)
          .sort();
        if (
          parents.length > 0 &&
          parents.every(
            (u) =>
              ours.nofollowOnly.has(p.v) ||
              ours.graph
                .edges(u, p.v)
                .every((e) => /\bnofollow\b/i.test(ours.graph.getEdgeAttribute(e, "rel") ?? "")),
          )
        )
          add("depth", p.v, "nofollow-path", detail);
        else if (parents.some((u) => !theirs.crawled.has(u)))
          add("depth", p.v, "parent-not-crawled-screaming-frog", detail);
        else if (sf.inlinks !== null && parents.some((u) => !theirs.edges.has(`${u} -> ${p.v}`)))
          add("depth", p.v, "link-not-in-screaming-frog", detail);
        else if (parents.some((u) => (theirs.depth.get(u) ?? Infinity) !== ours.depth.get(u)))
          add("depth", p.v, "cascade", detail);
        else add("depth", p.v, "other", detail);
      }
    }

    // Orphans.
    const rec = orphansOf(policyId, ours);
    const ourOrphans = new Set(rec?.orphans ?? []);
    const channels = new Map((rec?.inventory ?? []).map((e) => [e.node, e.channels]));
    let sfOrphans: Set<string> | null = null;
    if (sf.orphans !== null) {
      const source = new Map<string, string | null>();
      sfOrphans = new Set<string>();
      for (const o of sf.orphans) {
        const k = key(o.address);
        if (k === null || !isInternal(o.address)) continue;
        sfOrphans.add(k);
        if (!source.has(k)) source.set(k, o.source);
      }
      for (const v of [...sfOrphans].filter((k) => !ourOrphans.has(k)).sort()) {
        const src = source.get(v) ?? null;
        if (ours.depth.has(v))
          add("orphan-only-screaming-frog", v, "reachable-linklens", { sources: src });
        else if (channels.has(v))
          add("orphan-only-screaming-frog", v, "not-crawled-linklens", { sources: src });
        else
          add("orphan-only-screaming-frog", v, "not-in-linklens-channels", {
            sources: src ?? "its orphan sources",
          });
      }
      for (const v of [...ourOrphans].filter((k) => !(sfOrphans as Set<string>).has(k)).sort()) {
        const ch = (channels.get(v) ?? []).filter((c) => c !== "link_graph");
        const sfReadable = ch.some((c) => c === "xml_sitemap" || c === "robots_sitemap");
        if ((theirs.sources.get(v)?.size ?? 0) > 0 || theirs.depth.has(v))
          add("orphan-only-linklens", v, "reachable-screaming-frog");
        else if (!sfReadable)
          add("orphan-only-linklens", v, "channel-screaming-frog-does-not-read", {
            channels: ch.join(", "),
          });
        else
          add("orphan-only-linklens", v, "not-in-screaming-frog-orphans", {
            channels: ch.join(", "),
          });
      }
    }

    // Categories.
    const categories: CategorySummary[] = [];
    for (const kind of DISAGREEMENT_KINDS) {
      const items = found.filter((d) => d.kind === kind);
      const byCat = new Map<string, Disagreement[]>();
      for (const d of items) byCat.set(d.category, [...(byCat.get(d.category) ?? []), d]);
      const order = Object.keys(EXPLANATIONS[kind]);
      for (const [category, ds] of [...byCat].sort(
        (a, b) => b[1].length - a[1].length || order.indexOf(a[0]) - order.indexOf(b[0]),
      )) {
        const share = ds.length / items.length;
        // Fill the template from the category's evidence (the most common value per field).
        const fill = (field: string) => {
          const counts = new Map<string, number>();
          for (const d of ds) {
            const v = d.detail[field];
            if (v !== null && v !== undefined && v !== "")
              counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
          }
          return [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0] ?? field;
        };
        const template = EXPLANATIONS[kind][category] ?? category;
        categories.push({
          kind,
          category,
          count: ds.length,
          share,
          large: share >= config.e5LargeShare && ds.length >= config.e5LargeMin,
          explanation: template.replace(/\{(\w+)\}/g, (_m, f: string) => fill(f)),
          examples: ds.map((d) => d.node).slice(0, config.e5Examples),
        });
      }
    }

    const depthMaps = (side: "ours" | "sf") => new Map(depthPairs.map((p) => [p.v, p[side]]));
    return {
      policy: policyId,
      policyVersion: canonicalise.POLICIES[policyId].version,
      urls: {
        linklens: ours.crawled.size,
        screamingFrog: theirs.crawled.size,
        common: common.length,
        jaccard: stats.jaccard(ours.crawled, theirs.crawled),
      },
      inlinks: {
        pages: common.length,
        spearman:
          sf.inlinks === null
            ? null
            : stats.spearman(
                new Map(inlinkPairs.map((p) => [p.v, p.ours])),
                new Map(inlinkPairs.map((p) => [p.v, p.sf])),
              ),
        spearmanColumn: stats.spearman(
          new Map(
            common
              .filter((v) => theirs.column.has(v))
              .map((v) => [v, ours.sources.get(v)?.size ?? 0]),
          ),
          new Map(
            common
              .filter((v) => theirs.column.has(v))
              .map((v) => [v, theirs.column.get(v) as number]),
          ),
        ),
        largeDifferences: largeInlinks,
      },
      depth: {
        pages: depthPairs.length,
        exact:
          depthPairs.length === 0
            ? null
            : depthPairs.filter((p) => p.ours === p.sf).length / depthPairs.length,
        withinOne:
          depthPairs.length === 0
            ? null
            : depthPairs.filter((p) => Math.abs(p.ours - p.sf) <= 1).length / depthPairs.length,
        spearman: stats.spearman(depthMaps("ours"), depthMaps("sf")),
        meanAbsDifference:
          depthPairs.length === 0
            ? null
            : depthPairs.reduce((s, p) => s + Math.abs(p.ours - p.sf), 0) / depthPairs.length,
        seedDiffers,
      },
      orphans: {
        linklens: ourOrphans.size,
        screamingFrog: sfOrphans?.size ?? null,
        common:
          sfOrphans === null
            ? null
            : [...ourOrphans].filter((o) => (sfOrphans as Set<string>).has(o)).length,
        jaccard: sfOrphans === null ? null : stats.jaccard(ourOrphans, sfOrphans),
      },
      categories,
      disagreements: found,
    };
  });
  return { runId: inputs.runId, policies: results };
}
