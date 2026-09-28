/**
 * The schema.org types a page declares about **itself**, for the page-type classifier. Pure
 * string parsing of the stored raw HTML (`fetch_bodies`), so it also works on runs crawled before
 * it existed.
 *
 * Only page-level types count, never those of nested items: a category page whose ItemList holds
 * Products is not a product page. So:
 * - JSON-LD: the `@type` of each root object and each `@graph` member, and the `mainEntity` of a
 *   WebPage-like root (a WebPage whose main entity is a Product is about that product);
 * - microdata: `itemtype` on elements without `itemprop` (a top-level item, not a property of
 *   another one).
 *
 * Types are reduced to their local name ("https://schema.org/Product" → "Product"). Types that
 * describe parts of any page rather than the page (breadcrumbs, the site, the publisher,
 * navigation, images) are left out.
 */

/** Present on pages of every kind, so they say nothing about the page's type. */
export const IGNORED_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "BreadcrumbList",
  "ListItem",
  "WebSite",
  "WebPage",
  "ItemPage",
  "Organization",
  "Person",
  "ImageObject",
  "SiteNavigationElement",
  "WPHeader",
  "WPFooter",
  "WPSideBar",
  "SearchAction",
  "EntryPoint",
  "PostalAddress",
  "ContactPoint",
  "Thing",
]);

/** Page wrappers whose `mainEntity` says what the page is about. */
const WRAPPERS = new Set(["WebPage", "ItemPage"]);

const JSON_LD =
  /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
const ITEM_TAG = /<[a-z][^>]*?\bitemtype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
const ITEMPROP = /\sitemprop\s*=/i;

const localName = (t: string) => {
  const s = t.trim().replace(/[/#]+$/, "");
  const cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("#"), s.lastIndexOf(":"));
  return cut === -1 ? s : s.slice(cut + 1);
};

const typesOf = (o: Record<string, unknown>): string[] => {
  const t = o["@type"];
  return (Array.isArray(t) ? t : [t])
    .filter((x): x is string => typeof x === "string" && x !== "")
    .map(localName);
};

function pageLevel(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 5 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) pageLevel(v, out, depth + 1);
    return;
  }
  const o = value as Record<string, unknown>;
  if (Array.isArray(o["@graph"])) pageLevel(o["@graph"], out, depth + 1);
  const types = typesOf(o);
  for (const t of types) out.add(t);
  if (types.some((t) => WRAPPERS.has(t)) && o["mainEntity"] !== undefined) {
    pageLevel(o["mainEntity"], out, depth + 1);
  }
}

/** Pure: the page's own schema.org types, sorted, without IGNORED_SCHEMA_TYPES. Bad JSON is skipped. */
export function schemaTypes(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(JSON_LD)) {
    const raw = (m[1] ?? "")
      .trim()
      .replace(/^<!--/, "")
      .replace(/-->$/, "")
      .replace(/^<!\[CDATA\[/, "")
      .replace(/\]\]>$/, "")
      .trim();
    if (raw === "") continue;
    try {
      pageLevel(JSON.parse(raw), out);
    } catch {
      // Invalid JSON-LD is common in the wild; the page just has no types from this block.
    }
  }
  for (const m of html.matchAll(ITEM_TAG)) {
    if (ITEMPROP.test(m[0])) continue;
    for (const t of (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/)) if (t !== "") out.add(localName(t));
  }
  return [...out].filter((t) => t !== "" && !IGNORED_SCHEMA_TYPES.has(t)).sort();
}
