/** Path and query of a URL (the site is implied), e.g. "/blog/post?page=2". */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

export const fmtInt = (n: number) => n.toLocaleString("en-GB");
export const fmt2 = (n: number) => n.toFixed(2);
/** PageRank-sized numbers: three significant digits in exponent form, signed. */
export const fmtSci = (n: number, signed = false) =>
  `${signed && n >= 0 ? "+" : ""}${n.toExponential(2)}`;
export const fmtPct = (fraction: number) => `${Math.round(fraction * 100)}%`;

export function fmtMs(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/** Human names for pipeline stages and discovery channels. */
export const STAGE_NAMES: Record<string, string> = {
  crawl: "Crawl",
  extract: "Extract",
  discovery: "Discovery",
  canonicalise: "Canonicalise",
  graph: "Link graph",
  reconcile: "Reconcile",
  issues: "Issues",
  text: "Text",
  ref: "REF",
  embeddings: "Embeddings",
  prominence: "Prominence",
  diagnosis: "Diagnosis",
  candidates: "Candidates",
  counterfactual: "Counterfactual",
  kappa: "Effort κ",
  scoring: "Scoring",
  rescue: "Orphan rescue",
  explanations: "Explanations",
};

export const CHANNEL_NAMES: Record<string, string> = {
  link_graph: "Link graph",
  xml_sitemap: "XML sitemap",
  robots_sitemap: "robots.txt sitemap",
  html_sitemap: "HTML sitemap",
  feed: "RSS / Atom",
  llms_txt: "llms.txt",
};

export const SIGMA_NAMES: Record<string, string> = {
  refGateCosine: "Cosine gated by REF (default)",
  cosineOnly: "Cosine only",
  refOnly: "REF only",
  blended: "Blend of REF and cosine",
};

export const CASE_NAMES: Record<string, string> = {
  v4: "Missing",
  v3: "Buried",
  v2: "Good",
  v1: "Misleading",
};
