/**
 * Crawl scope and frontier keys.
 *
 * Deduplication uses the resolved URL string exactly as produced by WHATWG URL parsing
 * (`new URL(href, base).toString()`), with one exception: the fragment is dropped, because it is
 * never sent to the server (RFC 9110 §7.1), so `/a` and `/a#x` are the same request. Nothing else is
 * touched: no case folding, trailing-slash, query-sorting or index-file rules. Those belong to the
 * canonicalisation policies (P0–P5), applied later to the raw observations.
 */

/** The string a URL is fetched and deduplicated by. */
export function requestKey(url: URL): string {
  if (url.hash === "") return url.toString();
  const u = new URL(url);
  u.hash = "";
  return u.toString();
}

export function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/** Resolve an href against a base, or null if it is not a valid URL. */
export function resolveHref(href: string, base: string | URL): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

/**
 * Build the same-site test for a seed.
 * - exact (default): the URL's host (hostname plus port) equals the seed's; http and https both count.
 * - includeSubdomains: hostname equals the seed hostname minus a leading "www.", or ends with
 *   "." + that base, on the same port. `www.example.com` therefore admits `blog.example.com`.
 */
export function makeScope(seed: URL, includeSubdomains: boolean): (url: URL) => boolean {
  const seedHost = seed.host.toLowerCase();
  const base = seed.hostname.toLowerCase().replace(/^www\./, "");
  return (url) => {
    if (!isHttpUrl(url)) return false;
    if (!includeSubdomains) return url.host.toLowerCase() === seedHost;
    const host = url.hostname.toLowerCase();
    return url.port === seed.port && (host === base || host.endsWith(`.${base}`));
  };
}
