import { createHash } from "node:crypto";
import { isTag, type Element } from "domhandler";

function parentElement(el: Element): Element | null {
  return el.parent !== null && isTag(el.parent) ? el.parent : null;
}

/** An id usable as a CSS-like anchor: starts with a letter, no spaces. */
const STABLE_ID = /^[A-Za-z][\w-]*$/;

function step(el: Element): string {
  const parent = el.parent;
  if (parent === null || !("children" in parent)) return el.name;
  const same = parent.children.filter((c): c is Element => isTag(c) && c.name === el.name);
  return same.length > 1 ? `${el.name}:nth-of-type(${same.indexOf(el) + 1})` : el.name;
}

/**
 * Short CSS-like path to `el`: walks up until the nearest ancestor with a usable id (written
 * `tag#id`) or until <body> (not included). Positions are given only where siblings share a tag.
 * e.g. `nav#primary>ul>li:nth-of-type(2)>a`, `main>p:nth-of-type(3)>a`.
 */
export function domPath(el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node !== null; node = parentElement(node)) {
    if (node.name === "body" || node.name === "html") break;
    const id = node.attribs["id"];
    if (node !== el && id !== undefined && STABLE_ID.test(id)) {
      parts.push(`${node.name}#${id}`);
      break;
    }
    parts.push(step(node));
  }
  return parts.reverse().join(">");
}

/**
 * Class names that describe state, not structure: they differ between pages for the same block
 * (e.g. the current page's menu item), so they are left out of the signature.
 */
const STATE_CLASS =
  /^(active|current|selected|open|opened|show|shown|expanded|focus|hover|visited|is-.+|has-.+|current[-_].+|.+[-_](current|active|selected)(?:[-_].+)?|active[-_].+)$/;

/** Structural description of one ancestor: tag, stable id, and sorted structural classes. */
export function structuralStep(el: Element): string {
  const classes = new Set<string>();
  for (const c of (el.attribs["class"] ?? "").toLowerCase().split(/\s+/)) {
    if (c === "" || STATE_CLASS.test(c)) continue;
    classes.add(c.replace(/\d+/g, "#")); // menu-item-123 → menu-item-#
  }
  const id = el.attribs["id"];
  const idPart =
    id !== undefined && STABLE_ID.test(id) && !/\d/.test(id) ? `#${id.toLowerCase()}` : "";
  return `${el.name}${idPart}${[...classes]
    .sort()
    .map((c) => `.${c}`)
    .join("")}`;
}

/**
 * Hash of the link's ancestor structure (from <body> down to the link's parent): each ancestor's
 * tag, digit-free id and structural classes, with positions, state classes (active/current…) and
 * digits removed. The same link block (a menu, a footer list, a related-posts widget) therefore
 * gets the same signature on every page, and all links inside it share it.
 * Returns 16 hex chars of SHA-1.
 */
export function templateSignature(el: Element): string {
  const chain: string[] = [];
  for (let node = parentElement(el); node !== null; node = parentElement(node)) {
    if (node.name === "body" || node.name === "html") break;
    chain.push(structuralStep(node));
  }
  const text = chain.reverse().join(">");
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}
