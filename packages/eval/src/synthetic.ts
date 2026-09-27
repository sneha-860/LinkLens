import { db as q, type LinkLensConfig } from "@linklens/core";

/**
 * A deterministic synthetic site for scale measurements (artefact sizes, timings): a home page,
 * section hubs, articles, and four footer pages. Every page carries the same templated header
 * navigation and footer, a breadcrumb, and body links (hub → its first articles, each article →
 * the next one in its section as pagination, plus a few related articles). A small share of
 * articles is linked from nowhere and listed only in the XML sitemap (orphans).
 */
export interface SyntheticSiteOptions {
  readonly pages: number;
  readonly seed?: number;
  readonly sections?: number;
  /** Share of articles that nothing links to (default 0.02). */
  readonly orphanShare?: number;
  /** Body words per article, [min, max] (default [150, 400]). */
  readonly bodyWords?: readonly [number, number];
}

export interface SyntheticPage {
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly links: readonly {
    readonly path: string;
    readonly anchor: string;
    readonly region: string;
    readonly template: string;
  }[];
  readonly orphan: boolean;
}

/** mulberry32: a small seeded PRNG (the same seed gives the same site). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTION_NAMES = [
  "garden",
  "kitchen",
  "travel",
  "health",
  "finance",
  "music",
  "science",
  "sports",
  "books",
  "films",
  "history",
  "design",
];
const FOOTER = ["about", "contact", "privacy", "terms"];
const CONSONANTS = "bcdfghjklmnprstvwz";
const VOWELS = "aeiou";

export function syntheticSite(options: SyntheticSiteOptions): SyntheticPage[] {
  const rand = prng(options.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const word = () =>
    Array.from({ length: int(2, 3) }, () => pick([...CONSONANTS]) + pick([...VOWELS])).join("");
  const vocab = (n: number) => Array.from({ length: n }, word);

  const sectionCount = Math.min(options.sections ?? 10, SECTION_NAMES.length);
  const sections = SECTION_NAMES.slice(0, sectionCount);
  const common = vocab(200);
  const topical = new Map(sections.map((s) => [s, vocab(80)]));
  const [minWords, maxWords] = options.bodyWords ?? [150, 400];

  const text = (section: string | null, words: number) => {
    const own = section === null ? common : (topical.get(section) as string[]);
    const sentences: string[] = [];
    let left = words;
    while (left > 0) {
      const n = Math.min(left, int(8, 14));
      const ws = Array.from({ length: n }, () => (rand() < 0.7 ? pick(own) : pick(common)));
      sentences.push(`${ws.join(" ")}.`);
      left -= n;
    }
    return sentences.join(" ");
  };
  const titleOf = (section: string | null) =>
    Array.from({ length: int(2, 4) }, () =>
      pick(section === null ? common : (topical.get(section) as string[])),
    ).join(" ");

  // Articles are spread over the sections, in order.
  const articleCount = Math.max(0, options.pages - 1 - sectionCount - FOOTER.length);
  const articles = Array.from({ length: articleCount }, (_, i) => ({
    section: sections[i % sectionCount] as string,
    path: `/${sections[i % sectionCount]}/article-${Math.floor(i / sectionCount) + 1}`,
    title: "",
  }));
  for (const a of articles) a.title = titleOf(a.section);
  const orphanEvery = Math.round(1 / (options.orphanShare ?? 0.02));
  const orphan = new Set(
    articles.filter((_, i) => i > sectionCount && i % orphanEvery === 0).map((a) => a.path),
  );
  const linkable = articles.filter((a) => !orphan.has(a.path));
  const bySection = new Map(
    sections.map((s) => [s, articles.filter((a) => a.section === s && !orphan.has(a.path))]),
  );

  const header = [
    { path: "/", anchor: "Home" },
    ...sections.map((s) => ({ path: `/${s}/`, anchor: s })),
  ].map((l) => ({ ...l, region: "nav", template: "header-nav" }));
  const footer = FOOTER.map((f) => ({
    path: `/${f}`,
    anchor: f,
    region: "footer",
    template: "footer",
  }));
  const crumbs = (section: string) => [
    { path: "/", anchor: "Home", region: "breadcrumb", template: "crumbs" },
    { path: `/${section}/`, anchor: section, region: "breadcrumb", template: "crumbs" },
  ];
  const body = (links: { path: string; anchor: string }[], template: string) =>
    links.map((l) => ({ ...l, region: "main", template }));

  const pages: SyntheticPage[] = [];
  pages.push({
    path: "/",
    title: "Home",
    body: text(null, 200),
    links: [
      ...header,
      ...body(
        sections.map((s) => ({ path: `/${s}/`, anchor: `All about ${s}` })),
        "home-sections",
      ),
      ...footer,
    ],
    orphan: false,
  });
  for (const s of sections) {
    const list = bySection.get(s) ?? [];
    pages.push({
      path: `/${s}/`,
      title: s,
      body: text(s, 250),
      links: [
        ...header,
        ...crumbs(s).slice(0, 1),
        ...body(
          list.slice(0, 20).map((a) => ({ path: a.path, anchor: a.title })),
          "hub-list",
        ),
        ...footer,
      ],
      orphan: false,
    });
  }
  for (const f of FOOTER) {
    pages.push({
      path: `/${f}`,
      title: f,
      body: text(null, 120),
      links: [...header, ...footer],
      orphan: false,
    });
  }
  for (const a of articles) {
    const list = bySection.get(a.section) ?? [];
    const at = list.findIndex((x) => x.path === a.path);
    const next = at >= 0 ? list[at + 1] : undefined;
    const related = Array.from({ length: int(3, 6) }, () =>
      rand() < 0.85 || sections.length === 1 ? pick(list) : pick(linkable),
    ).filter((r): r is (typeof articles)[number] => r !== undefined && r.path !== a.path);
    pages.push({
      path: a.path,
      title: a.title,
      body: text(a.section, int(minWords, maxWords)),
      links: [
        ...header,
        ...crumbs(a.section),
        ...body(
          related.map((r) => ({ path: r.path, anchor: r.title })),
          "article-related",
        ),
        ...(next === undefined
          ? []
          : [{ path: next.path, anchor: "Next", region: "pagination", template: "pager" }]),
        ...footer,
      ],
      orphan: orphan.has(a.path),
    });
  }
  return pages;
}

/**
 * Store a synthetic site as a completed crawl: a fetch, page and link observations per page the
 * crawl could reach (not the orphans), the seed, and an XML sitemap listing every page (orphans
 * included). Returns the run id.
 */
export async function seedSyntheticRun(
  db: q.Queryable,
  origin: string,
  pages: readonly SyntheticPage[],
  config: Readonly<LinkLensConfig>,
): Promise<number> {
  const site = await q.insertSite(db, { rootUrl: `${origin}/` });
  const run = await q.createRun(db, { siteId: site.id, config });
  for (const p of pages) {
    if (p.orphan) continue;
    const f = await q.insertFetch(db, {
      runId: run.id,
      requestedUrl: origin + p.path,
      finalUrl: origin + p.path,
      statusCode: 200,
      contentType: "text/html",
    });
    await q.insertPage(db, {
      runId: run.id,
      fetchId: f.id,
      url: origin + p.path,
      title: p.title,
      h1: p.title,
      bodyText: p.body,
    });
    await q.insertLinkObservations(
      db,
      p.links.map((l, i) => ({
        runId: run.id,
        sourceFetchId: f.id,
        rawHref: l.path,
        resolvedUrl: origin + l.path,
        anchorText: l.anchor,
        domRegion: l.region,
        templateSignature: l.template,
        positionIndex: i,
      })),
    );
  }
  await q.insertDiscoveryObservations(db, [
    { runId: run.id, channel: "link_graph", url: `${origin}/`, detail: { kind: "seed" } },
    ...pages.map((p) => ({
      runId: run.id,
      channel: "xml_sitemap" as const,
      url: origin + p.path,
      sourceDocument: `${origin}/sitemap.xml`,
    })),
  ]);
  await q.setRunStatus(db, run.id, "completed");
  return run.id;
}
