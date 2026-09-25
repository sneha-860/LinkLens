import { isTag, type Element } from "domhandler";

/**
 * Page region a link sits in. `main` is explicit main content (<main>, <article>, role=main or a
 * content-like class/id); `body` is the default when nothing identifies the region.
 */
export const DOM_REGIONS = [
  "breadcrumb",
  "pagination",
  "nav",
  "header",
  "footer",
  "aside",
  "main",
  "body",
] as const;
export type DomRegion = (typeof DOM_REGIONS)[number];

/** Regions that are page chrome: stripped from body_text/paragraphs. */
export const CHROME_REGIONS: ReadonlySet<DomRegion> = new Set([
  "breadcrumb",
  "pagination",
  "nav",
  "header",
  "footer",
  "aside",
]);

const ROLE_REGIONS: Record<string, DomRegion> = {
  navigation: "nav",
  banner: "header",
  contentinfo: "footer",
  complementary: "aside",
  main: "main",
};

/** Class/id word lists (matched against whole words and their -/_ parts). */
const CLASS_WORDS: readonly (readonly [DomRegion, readonly string[]])[] = [
  ["nav", ["nav", "navbar", "navigation", "menu", "menubar", "topnav", "mainnav"]],
  ["header", ["header", "masthead", "topbar"]],
  ["footer", ["footer", "colophon"]],
  ["aside", ["sidebar", "aside"]],
  ["main", ["main", "content", "maincontent"]],
];

/** Sectioning ancestors that stop <header>/<footer> (and header/footer classes) being page chrome. */
const SECTIONING = new Set(["article", "aside", "main", "nav", "section"]);

function words(el: Element): Set<string> {
  const raw = `${el.attribs["class"] ?? ""} ${el.attribs["id"] ?? ""}`.toLowerCase();
  const out = new Set<string>();
  for (const w of raw.split(/\s+/)) {
    if (w === "") continue;
    out.add(w);
    for (const part of w.split(/[-_]+/)) if (part !== "") out.add(part);
  }
  return out;
}

function parentElement(el: Element): Element | null {
  return el.parent !== null && isTag(el.parent) ? el.parent : null;
}

/** Inside article/aside/main/nav/section (or role=main)? Then header/footer describe that section. */
function inSection(el: Element): boolean {
  for (let p = parentElement(el); p !== null; p = parentElement(p)) {
    if (SECTIONING.has(p.name) || p.attribs["role"]?.trim().toLowerCase() === "main") return true;
  }
  return false;
}

function relTokens(el: Element): string[] {
  return (el.attribs["rel"] ?? "").toLowerCase().split(/\s+/);
}

/**
 * Region signalled by this element alone (not its ancestors), or null. Order of evidence:
 *  1. breadcrumb / pagination (most specific: aria-label, class/id, schema.org BreadcrumbList;
 *     rel=next/prev on a link);
 *  2. semantic tags and ARIA roles;
 *  3. class/id heuristics.
 * <header>/<footer> and header/footer classes count only outside sectioning content (HTML-AAM:
 * a <header> inside <article> is not the page banner).
 */
export function elementRegion(el: Element): DomRegion | null {
  if (el.name === "html" || el.name === "body") return null;
  const label = (el.attribs["aria-label"] ?? "").toLowerCase();
  const classId = `${el.attribs["class"] ?? ""} ${el.attribs["id"] ?? ""}`.toLowerCase();
  const w = words(el);

  if (
    label.includes("breadcrumb") ||
    classId.includes("breadcrumb") ||
    /BreadcrumbList/i.test(el.attribs["itemtype"] ?? "")
  ) {
    return "breadcrumb";
  }
  if (
    /pagination|pager|page navigation/.test(label) ||
    /pagination|paginate|page-numbers|paging/.test(classId) ||
    w.has("pager") ||
    (el.name === "a" && relTokens(el).some((t) => t === "next" || t === "prev" || t === "previous"))
  ) {
    return "pagination";
  }

  const role = el.attribs["role"]?.trim().toLowerCase();
  if (role !== undefined && role in ROLE_REGIONS) return ROLE_REGIONS[role] ?? null;
  switch (el.name) {
    case "nav":
      return "nav";
    case "aside":
      return "aside";
    case "main":
    case "article":
      return "main";
    case "header":
    case "footer":
      if (!inSection(el)) return el.name;
      break;
  }

  for (const [region, list] of CLASS_WORDS) {
    if (!list.some((word) => w.has(word))) continue;
    if ((region === "header" || region === "footer") && inSection(el)) continue;
    return region;
  }
  return null;
}

/**
 * Region of a link: the nearest classified element from the link itself up to <body>, with two
 * refinements:
 *  - breadcrumb and pagination win outright (they are the most specific);
 *  - a nav inside a footer or aside is reported as footer/aside (footer menus, sidebar menus),
 *    while a nav inside the header stays nav (the main navigation).
 * Defaults to "body".
 */
export function classifyRegion(el: Element): DomRegion {
  let nearest: DomRegion | null = null;
  for (let node: Element | null = el; node !== null; node = parentElement(node)) {
    const r = elementRegion(node);
    if (r === null) continue;
    if (r === "breadcrumb" || r === "pagination") return r;
    if (nearest === null) {
      nearest = r;
      if (r !== "nav") return r;
    } else if (r === "footer" || r === "aside") {
      return r; // nav nested in footer/aside
    }
  }
  return nearest ?? "body";
}
