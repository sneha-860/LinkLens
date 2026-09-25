import { gunzipSync } from "node:zlib";
import { load } from "cheerio";
import { isTag, type AnyNode, type Element } from "domhandler";

/** Local name of an XML element ("sm:url" → "url"), lower-cased. */
const local = (el: Element) => (el.name.split(":").pop() ?? el.name).toLowerCase();

function* elements(nodes: readonly AnyNode[]): Generator<Element> {
  for (const n of nodes) {
    if (!isTag(n)) continue;
    yield n;
    yield* elements(n.children);
  }
}

const childrenNamed = (el: Element, name: string) =>
  el.children.filter((c): c is Element => isTag(c) && local(c) === name);

const textOf = (el: Element | undefined) =>
  el === undefined ? null : load(el, { xml: true }).text().trim() || null;

/**
 * Gunzip if the bytes are gzip (magic 1f 8b), whatever the URL or Content-Type says: servers
 * often send .gz sitemaps as application/octet-stream, and some transparently decompress.
 * Output is capped at maxBytes (zip-bomb guard).
 */
export function maybeGunzip(
  bytes: Uint8Array,
  maxBytes: number,
): { bytes: Uint8Array; gzipped: boolean } {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { bytes, gzipped: false };
  return { bytes: gunzipSync(bytes, { maxOutputLength: maxBytes }), gzipped: true };
}

export interface SitemapEntry {
  /** <loc> text as written (XML entities decoded, surrounding whitespace trimmed). */
  readonly loc: string;
  readonly lastmod: string | null;
}

export interface ParsedSitemap {
  readonly type: "urlset" | "sitemapindex" | "unknown";
  readonly entries: SitemapEntry[];
  /** More than maxUrls <loc> entries: the rest were ignored. */
  readonly truncated: boolean;
}

/** sitemaps.org XML: <urlset><url><loc> or <sitemapindex><sitemap><loc>. */
export function parseSitemap(xml: string, maxUrls: number): ParsedSitemap {
  const $ = load(xml, { xml: true });
  const root = $.root().children().toArray().find(isTag);
  const type = root === undefined ? "unknown" : local(root);
  if (root === undefined || (type !== "urlset" && type !== "sitemapindex")) {
    return { type: "unknown", entries: [], truncated: false };
  }
  const item = type === "urlset" ? "url" : "sitemap";
  const entries: SitemapEntry[] = [];
  let truncated = false;
  for (const el of childrenNamed(root, item)) {
    const loc = textOf(childrenNamed(el, "loc")[0]);
    if (loc === null) continue;
    if (entries.length >= maxUrls) {
      truncated = true;
      break;
    }
    entries.push({ loc, lastmod: textOf(childrenNamed(el, "lastmod")[0]) });
  }
  return { type, entries, truncated };
}

export interface FeedEntry {
  /** Entry link as written. */
  readonly link: string;
  readonly title: string | null;
}

export interface ParsedFeed {
  readonly format: "rss" | "atom" | "rdf" | "unknown";
  readonly entries: FeedEntry[];
}

/**
 * RSS 2.0 (<item><link>, else a permalink <guid>), RSS 1.0/RDF (<item><link>) and Atom
 * (<entry><link rel="alternate" href>, or a <link> with no rel).
 */
export function parseFeed(xml: string): ParsedFeed {
  const $ = load(xml, { xml: true });
  const root = $.root().children().toArray().find(isTag);
  if (root === undefined) return { format: "unknown", entries: [] };
  const rootName = local(root);
  const all = [...elements([root])];

  if (rootName === "feed") {
    const entries = all
      .filter((el) => local(el) === "entry")
      .flatMap((entry): FeedEntry[] => {
        const links = childrenNamed(entry, "link");
        const alt =
          links.find((l) => (l.attribs["rel"] ?? "alternate").toLowerCase() === "alternate") ??
          null;
        const href = alt?.attribs["href"];
        return href === undefined
          ? []
          : [{ link: href.trim(), title: textOf(childrenNamed(entry, "title")[0]) }];
      });
    return { format: "atom", entries };
  }
  if (rootName === "rss" || rootName === "rdf") {
    const entries = all
      .filter((el) => local(el) === "item")
      .flatMap((item): FeedEntry[] => {
        let link = textOf(childrenNamed(item, "link")[0]);
        if (link === null) {
          const guid = childrenNamed(item, "guid")[0];
          if (
            guid !== undefined &&
            (guid.attribs["ispermalink"] ?? guid.attribs["isPermaLink"]) !== "false"
          ) {
            link = textOf(guid);
          }
        }
        return link === null ? [] : [{ link, title: textOf(childrenNamed(item, "title")[0]) }];
      });
    return { format: rootName === "rss" ? "rss" : "rdf", entries };
  }
  return { format: "unknown", entries: [] };
}

export interface FeedLink {
  readonly href: string;
  readonly type: string;
  readonly title: string | null;
}

const FEED_TYPES = /^application\/(rss|atom|rdf)\+xml$|^application\/feed\+json$/i;

/** <link rel="alternate" type="application/rss+xml|atom+xml|rdf+xml|feed+json" href> in an HTML page. */
export function findFeedLinks(html: string): FeedLink[] {
  const $ = load(html);
  return $("link[href]")
    .toArray()
    .filter((el) => {
      const rel = (el.attribs["rel"] ?? "").toLowerCase().split(/\s+/);
      return rel.includes("alternate") && FEED_TYPES.test((el.attribs["type"] ?? "").trim());
    })
    .map((el) => ({
      href: el.attribs["href"] as string,
      type: (el.attribs["type"] as string).trim().toLowerCase(),
      title: el.attribs["title"] ?? null,
    }));
}

export interface LlmsLink {
  /** Link target as written. */
  readonly href: string;
  readonly text: string;
  /** The nearest preceding "## " section heading, or null. */
  readonly section: string | null;
}

/**
 * llms.txt (llmstxt.org): Markdown whose sections list links as `- [name](url): notes`.
 * Every Markdown inline link is taken, with its section; images (`![..](..)`) are not links.
 */
export function parseLlmsTxt(text: string): LlmsLink[] {
  const out: LlmsLink[] = [];
  let section: string | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const heading = /^#{2,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      section = heading[1] ?? null;
      continue;
    }
    for (const m of line.matchAll(/(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      if (m[1] === "!") continue;
      out.push({ href: m[3] as string, text: (m[2] as string).trim(), section });
    }
  }
  return out;
}

/** Anchor text or href that marks a link to an HTML sitemap page ("Sitemap", "Site map", /site-map). */
export function looksLikeSitemapLink(anchorText: string | null, href: string): boolean {
  const label = /\bsite[\s_-]?map\b/i.test(anchorText ?? "");
  const path = /(^|\/)(html[-_]?)?site[-_]?map(\.html?|\/)?($|[?#])/i.test(href);
  return label || path;
}
