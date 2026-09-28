import {
  canonicalise,
  db as q,
  fixes,
  graph,
  prominence,
  type LinkLensConfig,
} from "@linklens/core";

type PolicyId = canonicalise.PolicyId;

/**
 * Proxy validation: does structural prominence ω track real clicks? Prominence is our stand-in
 * for the patent's session counts (CLAUDE.md, Prominence › Limitations), so this checks it on a
 * site that has click data.
 *
 * - Link level (an analytics export: source_url, target_url, clicks). For every source page with
 *   clicks on at least one of its links, each out-link's structural ω(u,v) against its share of
 *   the source's clicks (0 for links without clicks). Spearman pooled over the links and the mean
 *   within-source Spearman (sources with ≥ proxyMinEdgesPerSource links), and how often the
 *   most prominent link is the most clicked (hit@1). Baseline: the raw link-count share
 *   (observations u→v / all of u's), which is what plain PageRank uses.
 * - Page level (a Search Console "Pages" export: page, clicks). Each crawled page's clicks
 *   against inbound prominence Σ_u ω(u,v) and prominence-weighted PageRank, with plain PageRank
 *   (link multiplicity) and distinct in-degree as baselines.
 *
 * Every Spearman has a seeded bootstrap 95% CI (resampling sources, or pages), and prominence is
 * compared with its baseline by a paired bootstrap of the difference.
 */

export const PROXY_VERSION = "proxy-validation@1.0.0";

// ---------- statistics on arrays (bootstrap resamples repeat keys) ----------

function averageRanks(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (
      j + 1 < order.length &&
      (order[j + 1] as readonly [number, number])[0] === (order[i] as readonly [number, number])[0]
    )
      j++;
    for (let k = i; k <= j; k++) r[(order[k] as readonly [number, number])[1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Spearman of paired arrays (Pearson on average ranks); null below 2 pairs or without variation. */
export function spearmanOf(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const ra = averageRanks(a);
  const rb = averageRanks(b);
  const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = m(ra);
  const mb = m(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = (ra[i] as number) - ma;
    const y = (rb[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? null : num / Math.sqrt(da * db);
}

export interface Estimate {
  readonly value: number | null;
  /** Bootstrap 95% percentile interval (null when too few resamples had a value). */
  readonly lo: number | null;
  readonly hi: number | null;
  readonly n: number;
}

const quantile = (sorted: readonly number[], p: number) => {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo);
};

/**
 * A statistic of `units` and its bootstrap interval: `stat` is applied to the units and to
 * `draws` resamples of them (with replacement, seeded). Resamples without a value are skipped.
 */
export function bootstrap<U>(
  units: readonly U[],
  stat: (units: readonly U[]) => number | null,
  draws: number,
  seed: number,
): Estimate {
  const value = stat(units);
  const random = graph.mulberry32(seed);
  const values: number[] = [];
  if (units.length > 0) {
    for (let d = 0; d < draws; d++) {
      const sample = Array.from(
        { length: units.length },
        () => units[Math.floor(random() * units.length)] as U,
      );
      const v = stat(sample);
      if (v !== null && Number.isFinite(v)) values.push(v);
    }
  }
  values.sort((a, b) => a - b);
  const ok = values.length >= Math.max(10, draws / 2);
  return {
    value,
    lo: ok ? quantile(values, 0.025) : null,
    hi: ok ? quantile(values, 0.975) : null,
    n: units.length,
  };
}

// ---------- link level ----------

export interface SourceLinks {
  readonly source: string;
  readonly links: {
    readonly target: string;
    readonly omega: number;
    readonly countShare: number;
    readonly clickShare: number;
  }[];
}

export interface LinkLevelResult {
  readonly rows: {
    readonly total: number;
    readonly used: number;
    readonly invalidUrl: number;
    readonly external: number;
    readonly selfLoop: number;
    /** Mapped, but no crawled link u→v under the policy (a click the graph cannot explain). */
    readonly noLink: number;
  };
  readonly sources: number;
  readonly links: number;
  readonly pooled: {
    readonly prominence: Estimate;
    readonly linkCount: Estimate;
    readonly difference: Estimate;
  };
  readonly withinSource: {
    readonly sources: number;
    readonly prominence: Estimate;
    readonly linkCount: Estimate;
    readonly difference: Estimate;
  };
  /** Share of sources whose most prominent link is their most clicked (ties split evenly). */
  readonly hitAt1: { readonly prominence: Estimate; readonly linkCount: Estimate };
}

/** Pure: the per-source link table from structural prominence and mapped click rows. */
export function sourceLinks(
  edges: readonly Pick<prominence.ProminenceEdge, "source" | "target" | "omega" | "observations">[],
  clicks: readonly prominence.NodeClicks[],
): { sources: SourceLinks[]; rows: LinkLevelResult["rows"] } {
  const bySource = new Map<string, typeof edges>();
  for (const e of edges) bySource.set(e.source, [...(bySource.get(e.source) ?? []), e]);
  const edgeKey = (s: string, t: string) => `${s}\u0000${t}`;
  const known = new Set(edges.map((e) => edgeKey(e.source, e.target)));
  const perEdge = new Map<string, number>();
  const rows = {
    total: clicks.length,
    used: 0,
    invalidUrl: 0,
    external: 0,
    selfLoop: 0,
    noLink: 0,
  };
  for (const c of clicks) {
    if (c.source === null || c.target === null) {
      if (c.reason === "external") rows.external += 1;
      else rows.invalidUrl += 1;
    } else if (c.source === c.target) rows.selfLoop += 1;
    else if (!known.has(edgeKey(c.source, c.target))) rows.noLink += 1;
    else {
      rows.used += 1;
      const k = edgeKey(c.source, c.target);
      perEdge.set(k, (perEdge.get(k) ?? 0) + c.clicks);
    }
  }
  const sources: SourceLinks[] = [];
  for (const [source, out] of [...bySource].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const total = out.reduce((s, e) => s + (perEdge.get(edgeKey(source, e.target)) ?? 0), 0);
    if (total <= 0) continue;
    const obs = out.reduce((s, e) => s + e.observations, 0);
    sources.push({
      source,
      links: [...out]
        .sort((a, b) => (a.target < b.target ? -1 : 1))
        .map((e) => ({
          target: e.target,
          omega: e.omega,
          countShare: obs === 0 ? 0 : e.observations / obs,
          clickShare: (perEdge.get(edgeKey(source, e.target)) ?? 0) / total,
        })),
    });
  }
  return { sources, rows };
}

type Predictor = "omega" | "countShare";

const pooled = (p: Predictor) => (ss: readonly SourceLinks[]) => {
  const links = ss.flatMap((s) => s.links);
  return spearmanOf(
    links.map((l) => l[p]),
    links.map((l) => l.clickShare),
  );
};
const within = (p: Predictor) => (ss: readonly SourceLinks[]) => {
  const rs = ss
    .map((s) =>
      spearmanOf(
        s.links.map((l) => l[p]),
        s.links.map((l) => l.clickShare),
      ),
    )
    .filter((x): x is number => x !== null);
  return rs.length === 0 ? null : rs.reduce((a, b) => a + b, 0) / rs.length;
};
const hit = (p: Predictor) => (ss: readonly SourceLinks[]) => {
  if (ss.length === 0) return null;
  let credit = 0;
  for (const s of ss) {
    const top = Math.max(...s.links.map((l) => l[p]));
    const best = Math.max(...s.links.map((l) => l.clickShare));
    const picked = s.links.filter((l) => l[p] === top);
    credit += picked.filter((l) => l.clickShare === best).length / picked.length;
  }
  return credit / ss.length;
};
const diff =
  (f: (p: Predictor) => (ss: readonly SourceLinks[]) => number | null) =>
  (ss: readonly SourceLinks[]) => {
    const a = f("omega")(ss);
    const b = f("countShare")(ss);
    return a === null || b === null ? null : a - b;
  };

/** Pure: the link-level validation. */
export function linkLevel(
  table: { sources: SourceLinks[]; rows: LinkLevelResult["rows"] },
  config: Pick<LinkLensConfig, "proxyBootstrap" | "proxyMinEdgesPerSource" | "randomSeed">,
): LinkLevelResult {
  const { sources } = table;
  const B = config.proxyBootstrap;
  const seed = config.randomSeed;
  const eligible = sources.filter((s) => s.links.length >= config.proxyMinEdgesPerSource);
  return {
    rows: table.rows,
    sources: sources.length,
    links: sources.reduce((n, s) => n + s.links.length, 0),
    pooled: {
      prominence: bootstrap(sources, pooled("omega"), B, seed),
      linkCount: bootstrap(sources, pooled("countShare"), B, seed),
      difference: bootstrap(sources, diff(pooled), B, seed),
    },
    withinSource: {
      sources: eligible.length,
      prominence: bootstrap(eligible, within("omega"), B, seed),
      linkCount: bootstrap(eligible, within("countShare"), B, seed),
      difference: bootstrap(eligible, diff(within), B, seed),
    },
    hitAt1: {
      prominence: bootstrap(sources, hit("omega"), B, seed),
      linkCount: bootstrap(sources, hit("countShare"), B, seed),
    },
  };
}

// ---------- page level ----------

export interface SearchConsoleRow {
  readonly url: string;
  readonly clicks: number;
  readonly line: number;
}

const URL_COLUMNS = ["top pages", "page", "pages", "url", "landing page", "address"];

export class SearchConsoleCsvError extends Error {
  override readonly name = "SearchConsoleCsvError";
  constructor(readonly problems: string[]) {
    super(
      `invalid Search Console CSV: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`,
    );
  }
}

/**
 * A Search Console "Pages" export (or any CSV with a page URL column and a clicks column):
 * columns found by name, case-insensitive; thousands separators allowed. Every problem is
 * reported with its line.
 */
export function parseSearchConsoleCsv(text: string): SearchConsoleRow[] {
  const records = prominence.parseCsv(text.replace(/^\uFEFF/, ""));
  const header = records[0]?.fields.map((f) => f.trim().toLowerCase()) ?? [];
  const urlAt = header.findIndex((h) => URL_COLUMNS.includes(h));
  const clicksAt = header.indexOf("clicks");
  if (urlAt < 0 || clicksAt < 0) {
    throw new SearchConsoleCsvError([
      `line 1: needs a page column (Top pages, Page, URL) and Clicks; found ${header.join(", ")}`,
    ]);
  }
  const problems: string[] = [];
  const out: SearchConsoleRow[] = [];
  for (const { fields, line } of records.slice(1)) {
    const url = (fields[urlAt] ?? "").trim();
    const raw = (fields[clicksAt] ?? "").trim().replace(/[,\s\u00a0]/g, "");
    if (url === "" && raw === "") continue;
    const clicks = Number(raw);
    if (url === "") problems.push(`line ${line}: empty page URL`);
    else if (!Number.isInteger(clicks) || clicks < 0) {
      problems.push(
        `line ${line}: clicks must be a non-negative integer, got "${fields[clicksAt] ?? ""}"`,
      );
    } else out.push({ url, clicks, line });
  }
  if (problems.length > 0) throw new SearchConsoleCsvError(problems);
  return out;
}

export interface PageRow {
  readonly node: string;
  readonly clicks: number;
  readonly inboundProminence: number;
  readonly prominencePagerank: number;
  readonly pagerank: number;
  readonly inDegree: number;
}

export type PagePredictor = Exclude<keyof PageRow, "node" | "clicks">;
export const PAGE_PREDICTORS: readonly PagePredictor[] = [
  "inboundProminence",
  "prominencePagerank",
  "pagerank",
  "inDegree",
];

export interface PageLevelResult {
  readonly rows: {
    readonly total: number;
    readonly used: number;
    readonly invalidUrl: number;
    readonly external: number;
    readonly notCrawled: number;
  };
  readonly pages: number;
  /** Crawled pages missing from the export counted as 0 clicks (else left out). */
  readonly zeroFill: boolean;
  readonly spearman: Record<PagePredictor, Estimate>;
  /** Prominence PageRank minus plain PageRank, and inbound prominence minus in-degree (paired). */
  readonly difference: { readonly pagerank: Estimate; readonly inbound: Estimate };
}

/** Pure: per crawled page, the predictors from the link graph and its Search Console clicks. */
export function pageTable(
  input: {
    readonly pages: readonly string[];
    readonly seed: string;
    readonly edges: readonly Pick<
      prominence.ProminenceEdge,
      "source" | "target" | "omega" | "structuralWeight" | "observations"
    >[];
    readonly rows: readonly SearchConsoleRow[];
    readonly isInternal: (url: string) => boolean;
    readonly canonicalise: (url: string) => string;
    readonly zeroFill: boolean;
  },
  config: fixes.PageRankParams,
): { pages: PageRow[]; rows: PageLevelResult["rows"] } {
  const crawled = new Set(input.pages);
  const clicks = new Map<string, number>();
  const rows = { total: input.rows.length, used: 0, invalidUrl: 0, external: 0, notCrawled: 0 };
  for (const r of input.rows) {
    if (!URL.canParse(r.url)) {
      rows.invalidUrl += 1;
      continue;
    }
    if (!input.isInternal(r.url)) {
      rows.external += 1;
      continue;
    }
    let node: string;
    try {
      node = input.canonicalise(r.url);
    } catch {
      rows.invalidUrl += 1;
      continue;
    }
    if (!crawled.has(node)) {
      rows.notCrawled += 1;
      continue;
    }
    rows.used += 1;
    clicks.set(node, (clicks.get(node) ?? 0) + r.clicks);
  }
  const nodes = [
    ...new Set([input.seed, ...input.pages, ...input.edges.flatMap((e) => [e.source, e.target])]),
  ].sort();
  const pr = (weight: (e: (typeof input.edges)[number]) => number) => {
    const g = fixes.weightedGraph(
      nodes,
      input.seed,
      input.edges.map((e) => ({ source: e.source, target: e.target, weight: weight(e) })),
    );
    const run = fixes.weightedPagerank(g, config);
    return new Map(nodes.map((n, i) => [n, run.scores[i] as number]));
  };
  const prominencePr = pr((e) => e.structuralWeight);
  const plainPr = pr((e) => e.observations);
  const inbound = new Map<string, number>();
  const indeg = new Map<string, number>();
  for (const e of input.edges) {
    inbound.set(e.target, (inbound.get(e.target) ?? 0) + e.omega);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const pages = [...crawled]
    .sort()
    .filter((n) => input.zeroFill || clicks.has(n))
    .map((node) => ({
      node,
      clicks: clicks.get(node) ?? 0,
      inboundProminence: inbound.get(node) ?? 0,
      prominencePagerank: prominencePr.get(node) ?? 0,
      pagerank: plainPr.get(node) ?? 0,
      inDegree: indeg.get(node) ?? 0,
    }));
  return { pages, rows };
}

/** Pure: the page-level validation. */
export function pageLevel(
  table: { pages: PageRow[]; rows: PageLevelResult["rows"] },
  zeroFill: boolean,
  config: Pick<LinkLensConfig, "proxyBootstrap" | "randomSeed">,
): PageLevelResult {
  const rho = (p: PagePredictor) => (ps: readonly PageRow[]) =>
    spearmanOf(
      ps.map((x) => x[p]),
      ps.map((x) => x.clicks),
    );
  const minus = (a: PagePredictor, b: PagePredictor) => (ps: readonly PageRow[]) => {
    const x = rho(a)(ps);
    const y = rho(b)(ps);
    return x === null || y === null ? null : x - y;
  };
  const B = config.proxyBootstrap;
  const seed = config.randomSeed;
  return {
    rows: table.rows,
    pages: table.pages.length,
    zeroFill,
    spearman: Object.fromEntries(
      PAGE_PREDICTORS.map((p) => [p, bootstrap(table.pages, rho(p), B, seed)]),
    ) as Record<PagePredictor, Estimate>,
    difference: {
      pagerank: bootstrap(table.pages, minus("prominencePagerank", "pagerank"), B, seed),
      inbound: bootstrap(table.pages, minus("inboundProminence", "inDegree"), B, seed),
    },
  };
}

// ---------- loading a run ----------

export interface ProxyInputs {
  readonly runId: number;
  readonly policyVersion: string;
  readonly config: Readonly<LinkLensConfig>;
  /** Structural prominence (analytics never used here: it is what is being validated). */
  readonly edges: prominence.ProminenceEdge[];
  readonly pages: string[];
  readonly seed: string;
  readonly isInternal: (url: string) => boolean;
  readonly canonicalise: (url: string) => string;
}

export async function loadProxyInputs(
  db: q.Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<ProxyInputs> {
  const [links, { observations }] = await Promise.all([
    prominence.loadPageLinks(db, runId, policyId),
    graph.loadRunGraphInputs(db, runId),
  ]);
  const structural = prominence.computeProminence({ pages: links.pages }, links.config);
  return {
    runId,
    policyVersion: links.policyVersion,
    config: links.config,
    edges: structural.edges,
    pages: links.pages.map((p) => p.node),
    seed: links.canonicalise(observations.seedUrl),
    isInternal: links.isInternal,
    canonicalise: links.canonicalise,
  };
}

export interface ProxyReport {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly source: string;
  readonly params: {
    readonly bootstrap: number;
    readonly seed: number;
    readonly minEdgesPerSource: number;
    readonly prominenceRegionWeights: LinkLensConfig["prominenceRegionWeights"];
    readonly prominencePositionDecay: number;
    readonly prominenceSitewideShare: number;
    readonly prominenceSitewideDiscount: number;
  };
  readonly linkLevel?: LinkLevelResult;
  readonly pageLevel?: PageLevelResult;
}

/** The prominence weights used (E-series results that depend on ω report them). */
export function proxyParams(config: Readonly<LinkLensConfig>): ProxyReport["params"] {
  return {
    bootstrap: config.proxyBootstrap,
    seed: config.randomSeed,
    minEdgesPerSource: config.proxyMinEdgesPerSource,
    prominenceRegionWeights: config.prominenceRegionWeights,
    prominencePositionDecay: config.prominencePositionDecay,
    prominenceSitewideShare: config.prominenceSitewideShare,
    prominenceSitewideDiscount: config.prominenceSitewideDiscount,
  };
}

const f3 = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
const est = (e: Estimate) => `${f3(e.value)} [${f3(e.lo)}, ${f3(e.hi)}]`;

/** Markdown for the console. */
export function proxyMarkdown(r: ProxyReport): string {
  const out = [
    `## Prominence proxy validation, run ${r.runId} (${r.policyVersion}), ${r.source}`,
    "",
  ];
  if (r.linkLevel !== undefined) {
    const l = r.linkLevel;
    out.push(
      `### Link level: ω(u,v) vs the link's share of u's clicks`,
      "",
      `${l.sources} sources, ${l.links} links; rows used ${l.rows.used} of ${l.rows.total} (no crawled link ${l.rows.noLink}, external ${l.rows.external}, invalid ${l.rows.invalidUrl}, self-loop ${l.rows.selfLoop}).`,
      "",
      "| Spearman (95% CI) | prominence ω | link-count share | ω − count |",
      "| --- | --- | --- | --- |",
      `| pooled over links | ${est(l.pooled.prominence)} | ${est(l.pooled.linkCount)} | ${est(l.pooled.difference)} |`,
      `| mean within source (${l.withinSource.sources} sources) | ${est(l.withinSource.prominence)} | ${est(l.withinSource.linkCount)} | ${est(l.withinSource.difference)} |`,
      `| hit@1 (top link = most clicked) | ${est(l.hitAt1.prominence)} | ${est(l.hitAt1.linkCount)} | |`,
      "",
    );
  }
  if (r.pageLevel !== undefined) {
    const p = r.pageLevel;
    out.push(
      `### Page level: Search Console clicks`,
      "",
      `${p.pages} pages${p.zeroFill ? " (crawled pages missing from the export count as 0 clicks)" : " (pages in both the crawl and the export)"}; rows used ${p.rows.used} of ${p.rows.total} (not crawled ${p.rows.notCrawled}, external ${p.rows.external}, invalid ${p.rows.invalidUrl}).`,
      "",
      "| Predictor | Spearman with clicks (95% CI) |",
      "| --- | --- |",
      `| inbound prominence Σ ω | ${est(p.spearman.inboundProminence)} |`,
      `| prominence-weighted PageRank | ${est(p.spearman.prominencePagerank)} |`,
      `| PageRank (link multiplicity) | ${est(p.spearman.pagerank)} |`,
      `| in-degree (distinct sources) | ${est(p.spearman.inDegree)} |`,
      `| prominence PR − PageRank | ${est(p.difference.pagerank)} |`,
      `| inbound prominence − in-degree | ${est(p.difference.inbound)} |`,
      "",
    );
  }
  out.push(
    `Bootstrap ${r.params.bootstrap} resamples, seed ${r.params.seed}. Region weights ${JSON.stringify(r.params.prominenceRegionWeights)}, position decay ${r.params.prominencePositionDecay}, site-wide discount ${r.params.prominenceSitewideDiscount} above ${r.params.prominenceSitewideShare}.`,
  );
  return `${out.join("\n")}\n`;
}
