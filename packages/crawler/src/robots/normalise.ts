/**
 * Percent-encoding normalisation for RFC 9309 §2.2.2 matching.
 *
 * Both patterns and URL paths are brought to one canonical octet form before comparison:
 *  - %XX of an unreserved character (RFC 3986: ALPHA / DIGIT / "-" / "." / "_" / "~") is decoded;
 *  - every other %XX is kept, with hex upper-cased;
 *  - non-ASCII characters (and space/controls) are UTF-8 percent-encoded.
 *
 * This is used for comparison only. Stored raw values are never rewritten.
 */

const HEX = /^[0-9A-Fa-f]{2}$/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const encoder = new TextEncoder();

function encodeOctets(ch: string): string {
  return Array.from(
    encoder.encode(ch),
    (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
}

export function normaliseOctets(input: string): string {
  let out = "";
  const chars = Array.from(input); // iterate by code point
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (ch === "%") {
      const hex = `${chars[i + 1] ?? ""}${chars[i + 2] ?? ""}`;
      if (HEX.test(hex)) {
        const decoded = String.fromCharCode(parseInt(hex, 16));
        out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
        i += 2;
        continue;
      }
      out += "%";
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    out += code <= 0x20 || code >= 0x7f ? encodeOctets(ch) : ch;
  }
  return out;
}

/**
 * Normalise a rule pattern. `*` stays a wildcard and a trailing `$` stays an end anchor; a `$`
 * anywhere else is a literal and becomes %24 (a literal `*` must be written %2A, RFC 9309 §2.2.3).
 */
export function normalisePattern(pattern: string): string {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  return normaliseOctets(body).replaceAll("$", "%24") + (anchored ? "$" : "");
}

/**
 * The part of a URL that rules match against: path plus query, never the fragment (RFC 9309 §2.2.2).
 * Literal `*` and `$` are encoded so they can only match the %2A / %24 escapes in a pattern.
 */
export function matchTarget(url: URL): string {
  const pathAndQuery = (url.pathname === "" ? "/" : url.pathname) + url.search;
  return normaliseOctets(pathAndQuery).replaceAll("*", "%2A").replaceAll("$", "%24");
}
