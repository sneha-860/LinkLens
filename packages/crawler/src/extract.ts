import { parseDocument } from "htmlparser2";
import { isTag, isText, type AnyNode, type Element } from "domhandler";
import { getAttributeValue, getElementsByTagName } from "domutils";
import type { db } from "@linklens/core";
import { resolveHref } from "./scope.js";

/**
 * Raw extraction from one HTML document. Values are taken as written (entity-decoded, as HTML
 * requires) and whitespace-collapsed for text only; hrefs and canonicals are never rewritten.
 */
export interface ExtractedLink {
  /** href attribute exactly as written. */
  readonly rawHref: string;
  /** WHATWG resolution against the document base (honours <base href>), or null if invalid. */
  readonly resolvedUrl: string | null;
  readonly anchorText: string | null;
  readonly rel: string | null;
  /** Nearest landmark ancestor: header, nav, main, footer, aside (or ARIA role equivalent). */
  readonly domRegion: string | null;
  /** e.g. "html>body>nav>ul>li:nth-of-type(2)>a". */
  readonly domPath: string;
  /** 0-based position among the document's links. */
  readonly positionIndex: number;
}

export interface ExtractedPage {
  readonly title: string | null;
  readonly h1: string | null;
  readonly headings: db.Heading[];
  /** href of <link rel="canonical"> exactly as written. */
  readonly metaCanonical: string | null;
  readonly metaRobots: string | null;
  readonly bodyText: string | null;
  readonly paragraphs: string[];
  readonly lang: string | null;
  readonly links: ExtractedLink[];
}

const SKIP_TEXT = new Set(["script", "style", "noscript", "template", "head"]);
const LANDMARK_TAGS = new Set(["header", "nav", "main", "footer", "aside"]);
const LANDMARK_ROLES: Record<string, string> = {
  banner: "header",
  navigation: "nav",
  main: "main",
  contentinfo: "footer",
  complementary: "aside",
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const orNull = (s: string) => (s === "" ? null : s);

/** Visible-ish text: skips script/style/etc. and adds img alt text. */
function text(node: AnyNode): string {
  if (isText(node)) return node.data;
  if (!isTag(node)) return "";
  if (SKIP_TEXT.has(node.name)) return "";
  if (node.name === "img") return ` ${node.attribs["alt"] ?? ""} `;
  const parts = node.children.map(text);
  // Block-ish boundaries should not glue words together.
  return /^(p|div|li|h[1-6]|br|tr|td|th|section|article)$/.test(node.name)
    ? ` ${parts.join("")} `
    : parts.join("");
}

function domPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node !== null) {
    const parent: AnyNode | null = node.parent;
    const name = node.name;
    if (parent !== null && "children" in parent) {
      const same = parent.children.filter((c): c is Element => isTag(c) && c.name === name);
      parts.push(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(node) + 1})` : name);
    } else {
      parts.push(name);
    }
    node = parent !== null && isTag(parent) ? parent : null;
  }
  return parts.reverse().join(">");
}

function region(el: Element): string | null {
  for (let node = el.parent; node !== null && isTag(node); node = node.parent) {
    const role = node.attribs["role"]?.trim().toLowerCase();
    if (role !== undefined && role in LANDMARK_ROLES) return LANDMARK_ROLES[role] ?? null;
    if (LANDMARK_TAGS.has(node.name)) return node.name;
  }
  return null;
}

function hasRelToken(el: Element, token: string): boolean {
  return (el.attribs["rel"] ?? "").toLowerCase().split(/\s+/).includes(token);
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const doc = parseDocument(html, { decodeEntities: true, lowerCaseTags: true });
  const byTag = (tag: string) => getElementsByTagName(tag, doc, true);

  const baseHref = byTag("base").find((b) => b.attribs["href"] !== undefined)?.attribs["href"];
  const base = (baseHref !== undefined ? resolveHref(baseHref, pageUrl) : null) ?? pageUrl;

  const headings: db.Heading[] = [];
  const walk = (node: AnyNode) => {
    if (!isTag(node)) return;
    const m = /^h([1-6])$/.exec(node.name);
    if (m !== null) {
      const t = collapse(text(node));
      if (t !== "") headings.push({ level: Number(m[1]) as db.Heading["level"], text: t });
      return;
    }
    node.children.forEach(walk);
  };
  doc.children.forEach(walk);

  const canonical = byTag("link").find((l) => hasRelToken(l, "canonical"));
  const robotsMeta = byTag("meta").find(
    (m) => (m.attribs["name"] ?? "").trim().toLowerCase() === "robots",
  );
  const titleEl = byTag("title")[0];
  const html0 = byTag("html")[0];
  const body = byTag("body")[0];

  const anchors = getElementsByTagName((name) => name === "a" || name === "area", doc, true).filter(
    (el) => el.attribs["href"] !== undefined,
  );

  const links = anchors.map((el, positionIndex): ExtractedLink => {
    const rawHref = el.attribs["href"] as string;
    const resolved = resolveHref(rawHref, base);
    const anchor =
      collapse(text(el)) || collapse(el.attribs["aria-label"] ?? el.attribs["alt"] ?? "");
    return {
      rawHref,
      resolvedUrl: resolved?.toString() ?? null,
      anchorText: orNull(anchor),
      rel: el.attribs["rel"] ?? null,
      domRegion: region(el),
      domPath: domPath(el),
      positionIndex,
    };
  });

  return {
    title: titleEl !== undefined ? orNull(collapse(text(titleEl))) : null,
    h1: headings.find((h) => h.level === 1)?.text ?? null,
    headings,
    metaCanonical: canonical !== undefined ? (getAttributeValue(canonical, "href") ?? null) : null,
    metaRobots: robotsMeta?.attribs["content"] ?? null,
    bodyText: body !== undefined ? orNull(collapse(text(body))) : null,
    paragraphs: byTag("p")
      .map((p) => collapse(text(p)))
      .filter((p) => p !== ""),
    lang: html0?.attribs["lang"] ?? null,
    links,
  };
}
