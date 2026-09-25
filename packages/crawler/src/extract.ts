import { load, type CheerioAPI } from "cheerio";
import { isTag, isText, type AnyNode, type Element } from "domhandler";
import type { db } from "@linklens/core";
import { CHROME_REGIONS, classifyRegion, elementRegion, type DomRegion } from "./html/region.js";
import { resolveReference } from "./html/resolve.js";
import { domPath, templateSignature } from "./html/structure.js";

/**
 * Raw extraction from one HTML document (Cheerio / parse5, so parsing matches browsers).
 * Attribute values are taken as written (entity-decoded, as HTML requires); hrefs and canonicals
 * are never rewritten. Text is whitespace-collapsed.
 */
export interface ExtractedLink {
  /** href attribute exactly as written. */
  readonly rawHref: string;
  /**
   * RFC 3986 resolution against the document base (the <base href> if present, else the page
   * URL), and nothing else: no case folding, port or percent-encoding changes. Keeps the fragment.
   */
  readonly resolvedUrl: string;
  /** Link text, with img alt text for image links; null if empty. */
  readonly anchorText: string | null;
  readonly rel: string | null;
  readonly domRegion: DomRegion;
  /** Short CSS-like path, e.g. "nav#primary>ul>li:nth-of-type(2)>a". */
  readonly domPath: string;
  /** Hash of the ancestor structure; equal for the same link block across pages. */
  readonly templateSignature: string;
  /** 0-based position among the document's <a href> elements. */
  readonly positionIndex: number;
}

export interface ExtractedPage {
  readonly title: string | null;
  readonly h1: string | null;
  readonly headings: db.Heading[];
  /** href of the first <link rel="canonical"> exactly as written. */
  readonly metaCanonical: string | null;
  readonly metaRobots: string | null;
  /** Main content text: nav/header/footer/aside/breadcrumb/pagination stripped. */
  readonly bodyText: string | null;
  /** <p> and <li> texts of the main content, in document order. */
  readonly paragraphs: string[];
  readonly lang: string | null;
  readonly links: ExtractedLink[];
  /** meta robots says nofollow (or none). Recorded only: links are still all observed. */
  readonly nofollow: boolean;
}

const SKIP_TEXT = new Set(["script", "style", "noscript", "template", "head", "svg", "iframe"]);
const BLOCK =
  /^(p|div|li|ul|ol|dl|dt|dd|h[1-6]|br|tr|td|th|table|section|article|header|footer|nav|aside|main|blockquote|pre|figure|figcaption|form)$/;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const orNull = (s: string) => (s === "" ? null : s);

/**
 * Text of a subtree, including img alt, skipping script/style/etc. and any subtree `skip` rejects.
 * Block elements are padded so words from adjacent blocks do not run together.
 */
function textOf(node: AnyNode, skip: (el: Element) => boolean = () => false): string {
  if (isText(node)) return node.data;
  if (!isTag(node) || SKIP_TEXT.has(node.name) || skip(node)) return "";
  if (node.name === "img") return ` ${node.attribs["alt"] ?? ""} `;
  const inner = node.children.map((c) => textOf(c, skip)).join("");
  return BLOCK.test(node.name) ? ` ${inner} ` : inner;
}

const isChrome = (el: Element) => {
  const r = elementRegion(el);
  return r !== null && CHROME_REGIONS.has(r);
};

/** Main content root: the first <main>/[role=main], else <body>. */
function contentRoot($: CheerioAPI): Element | undefined {
  return ($("main, [role=main]").get(0) ?? $("body").get(0)) as Element | undefined;
}

/** <p> and <li> texts under `root`, skipping chrome. An <li> excludes its nested lists and <p>s. */
function paragraphsOf(root: Element): string[] {
  const out: string[] = [];
  const walk = (node: AnyNode) => {
    if (!isTag(node) || SKIP_TEXT.has(node.name) || isChrome(node)) return;
    if (node.name === "p") {
      const t = collapse(textOf(node, isChrome));
      if (t !== "") out.push(t);
      return; // a <p> cannot contain block content worth a second entry
    }
    if (node.name === "li") {
      const own = collapse(
        textOf(
          node,
          (el) => isChrome(el) || el.name === "ul" || el.name === "ol" || el.name === "p",
        ),
      );
      if (own !== "") out.push(own);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

function hasToken(value: string | undefined, token: string): boolean {
  return (value ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .includes(token);
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = load(html);

  // HTML: the document base URL is the first <base href>, resolved against the document URL.
  const baseHref = $("base[href]").first().attr("href");
  const base = baseHref !== undefined ? resolveReference(pageUrl, baseHref) : pageUrl;

  const headings: db.Heading[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = collapse(textOf(el));
    if (text !== "")
      headings.push({ level: Number(el.name.slice(1)) as db.Heading["level"], text });
  });

  const canonical = $("link[href]")
    .filter((_, el) => hasToken(el.attribs["rel"], "canonical"))
    .first()
    .attr("href");
  const robots = $("meta[content]")
    .filter((_, el) => (el.attribs["name"] ?? "").trim().toLowerCase() === "robots")
    .first()
    .attr("content");

  const links = $("a[href]")
    .toArray()
    .map((el, positionIndex): ExtractedLink => {
      const rawHref = el.attribs["href"] as string;
      const anchor = collapse(textOf(el)) || collapse(el.attribs["aria-label"] ?? "");
      return {
        rawHref,
        resolvedUrl: resolveReference(base, rawHref),
        anchorText: orNull(anchor),
        rel: el.attribs["rel"] ?? null,
        domRegion: classifyRegion(el),
        domPath: domPath(el),
        templateSignature: templateSignature(el),
        positionIndex,
      };
    });

  const root = contentRoot($);
  const title = $("title").first();
  return {
    title: title.length > 0 ? orNull(collapse(title.text())) : null,
    h1: headings.find((h) => h.level === 1)?.text ?? null,
    headings,
    metaCanonical: canonical ?? null,
    metaRobots: robots ?? null,
    bodyText: root !== undefined ? orNull(collapse(textOf(root, isChrome))) : null,
    paragraphs: root !== undefined ? paragraphsOf(root) : [],
    lang: $("html").attr("lang") ?? null,
    links,
    nofollow: hasToken(robots, "nofollow") || hasToken(robots, "none"),
  };
}
