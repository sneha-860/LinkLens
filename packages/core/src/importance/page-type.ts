import type { PageType, PageTypeRules } from "../config.js";
import { parseReference } from "../url/rfc3986.js";

/** What the classifier sees of one page. */
export interface PageSignals {
  /** The node (or page URL); only its path and query are matched. */
  readonly url: string;
  /** The crawl's seed node (the homepage). */
  readonly isSeed: boolean;
  /** schema.org types from its HTML (`schemaTypes`); empty when unknown. */
  readonly schemaTypes: readonly string[];
  /** Crawled as HTML: the structure signals below are known (false: URL rules only). */
  readonly crawled: boolean;
  /** Words of the main-content text (`body_text`). */
  readonly bodyWords: number;
  /** Main-content link observations (dom_region main/body), and the words of their anchors. */
  readonly bodyLinks: number;
  readonly bodyLinkWords: number;
  /** A pagination block, or a rel=next/prev link. */
  readonly pagination: boolean;
}

export interface PageTypeResult {
  readonly type: PageType;
  /**
   * The rule that decided: "seed", "url:<type>", "schema:<Type>", "structure:hub",
   * "structure:article" or "default".
   */
  readonly rule: string;
  /** The matching pattern, schema type or measurements, for explanations. */
  readonly evidence: string;
}

const wordsIn = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Words of a text (tokens with a letter or digit). */
export const countWords = (text: string | null) => (text === null ? 0 : wordsIn(text));

/** Path and query of a URL, as the URL rules see it ("/" for an empty path). */
export function pathAndQuery(url: string): string {
  try {
    const { path, query } = parseReference(url);
    const p = path === "" ? "/" : path;
    return query === undefined ? p : `${p}?${query}`;
  } catch {
    return url;
  }
}

/** Compiled rules (regexes built once). */
export interface CompiledRules {
  readonly rules: PageTypeRules;
  readonly url: Readonly<Record<"utility" | "product" | "hub" | "article", readonly RegExp[]>>;
}

export function compileRules(rules: PageTypeRules): CompiledRules {
  const re = (ps: readonly string[]) => ps.map((p) => new RegExp(p, "i"));
  return {
    rules,
    url: {
      utility: re(rules.utility.url),
      product: re(rules.product.url),
      hub: re(rules.hub.url),
      article: re(rules.article.url),
    },
  };
}

/**
 * Pure, rule-based page type. First match wins:
 * 1. the seed → homepage;
 * 2. a utility URL pattern or schema type → utility (login, cart, account, search, tags);
 * 3. schema.org types: product, then article, then hub types;
 * 4. URL patterns: product, then hub (so /blog/page/2 is not an article), then article;
 * 5. structure (crawled pages): a hub has many main-content links making up much of its text,
 *    or pagination; an article has long text with few links;
 * 6. otherwise "other".
 */
export function classifyPage(s: PageSignals, compiled: CompiledRules): PageTypeResult {
  const { rules, url } = compiled;
  if (s.isSeed) return { type: "homepage", rule: "seed", evidence: "the crawl's seed" };
  const path = pathAndQuery(s.url);
  const urlHit = (t: keyof CompiledRules["url"]) => url[t].find((r) => r.test(path));
  const schemaHit = (t: "utility" | "product" | "hub" | "article") =>
    rules[t].schema.find((x) => s.schemaTypes.includes(x));

  const utilityUrl = urlHit("utility");
  if (utilityUrl !== undefined)
    return { type: "utility", rule: "url:utility", evidence: utilityUrl.source };
  const utilitySchema = schemaHit("utility");
  if (utilitySchema !== undefined) {
    return { type: "utility", rule: `schema:${utilitySchema}`, evidence: utilitySchema };
  }
  for (const t of ["product", "article", "hub"] as const) {
    const hit = schemaHit(t);
    if (hit !== undefined) return { type: t, rule: `schema:${hit}`, evidence: hit };
  }
  for (const t of ["product", "hub", "article"] as const) {
    const hit = urlHit(t);
    if (hit !== undefined) return { type: t, rule: `url:${t}`, evidence: hit.source };
  }
  if (s.crawled) {
    const st = rules.structure;
    const density = s.bodyWords === 0 ? 0 : Math.min(1, s.bodyLinkWords / s.bodyWords);
    const measured = `${s.bodyLinks} main-content links, ${s.bodyWords} words, ${Math.round(100 * density)}% in links${s.pagination ? ", pagination" : ""}`;
    if (
      (s.bodyLinks >= st.hubMinBodyLinks && density >= st.hubMinLinkDensity) ||
      (s.pagination && s.bodyLinks >= st.hubPaginationMinBodyLinks)
    ) {
      return { type: "hub", rule: "structure:hub", evidence: measured };
    }
    if (s.bodyWords >= st.articleMinWords && density <= st.articleMaxLinkDensity) {
      return { type: "article", rule: "structure:article", evidence: measured };
    }
  }
  return { type: "other", rule: "default", evidence: "no rule matched" };
}
