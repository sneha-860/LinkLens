/**
 * Which link targets belong to the site, mirroring the crawler's scope rule (so the graph covers
 * what was crawlable): http(s) only; same host (hostname + port) as the seed, or, with
 * includeSubdomains, the seed's hostname minus "www." and its subdomains on the same port.
 * WHATWG URL is used here only to read the host; node ids come from the canonicalisation policy.
 */
export function makeInternalTest(
  seedUrl: string,
  includeSubdomains: boolean,
): (url: string) => boolean {
  const seed = new URL(seedUrl);
  const seedHost = seed.host.toLowerCase();
  const base = seed.hostname.toLowerCase().replace(/^www\./, "");
  return (raw) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!includeSubdomains) return u.host.toLowerCase() === seedHost;
    const host = u.hostname.toLowerCase();
    return u.port === seed.port && (host === base || host.endsWith(`.${base}`));
  };
}
