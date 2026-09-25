/**
 * RFC 3986 URI references: parsing (Appendix B), reference resolution (§5.2), recomposition
 * (§5.3) and the building blocks of syntax-based normalisation (§6.2.2). Pure string code.
 *
 * Deliberately not WHATWG `URL`: that also lower-cases hosts, drops ports, re-encodes, turns "\"
 * into "/" and so on. Raw observations must not carry any of that, and the canonicalisation
 * policies (P0–P5) must say exactly which normalisations they apply.
 */

export interface Components {
  scheme: string | undefined;
  authority: string | undefined;
  path: string;
  query: string | undefined;
  fragment: string | undefined;
}

/** RFC 3986 Appendix B. Every string matches; undefined means "component absent". */
const URI_REFERENCE = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

/** Leading/trailing ASCII whitespace as HTML defines it (TAB, LF, FF, CR, SPACE). */
const ASCII_WS_EDGES = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

export function parseReference(ref: string): Components {
  const m = URI_REFERENCE.exec(ref);
  // The pattern matches every string; the fallback only satisfies the type checker.
  if (m === null) {
    return {
      scheme: undefined,
      authority: undefined,
      path: ref,
      query: undefined,
      fragment: undefined,
    };
  }
  return { scheme: m[1], authority: m[2], path: m[3] ?? "", query: m[4], fragment: m[5] };
}

/** RFC 3986 §5.2.4. */
export function removeDotSegments(path: string): string {
  let input = path;
  const output: string[] = [];
  while (input.length > 0) {
    if (input.startsWith("../")) input = input.slice(3);
    else if (input.startsWith("./")) input = input.slice(2);
    else if (input.startsWith("/./")) input = input.slice(2);
    else if (input === "/.") input = "/";
    else if (input.startsWith("/../")) {
      input = input.slice(3);
      output.pop();
    } else if (input === "/..") {
      input = "/";
      output.pop();
    } else if (input === "." || input === "..") input = "";
    else {
      const next = input.indexOf("/", input.startsWith("/") ? 1 : 0);
      const segment = next === -1 ? input : input.slice(0, next);
      output.push(segment);
      input = input.slice(segment.length);
    }
  }
  return output.join("");
}

/** RFC 3986 §5.2.3. */
function merge(base: Components, refPath: string): string {
  if (base.authority !== undefined && base.path === "") return `/${refPath}`;
  const slash = base.path.lastIndexOf("/");
  return slash === -1 ? refPath : base.path.slice(0, slash + 1) + refPath;
}

/** RFC 3986 §5.3. */
export function recompose(c: Components): string {
  let out = "";
  if (c.scheme !== undefined) out += `${c.scheme}:`;
  if (c.authority !== undefined) out += `//${c.authority}`;
  out += c.path;
  if (c.query !== undefined) out += `?${c.query}`;
  if (c.fragment !== undefined) out += `#${c.fragment}`;
  return out;
}

/**
 * Resolve `reference` against the absolute URI `base` (RFC 3986 §5.2.2, strict parser).
 * The only preprocessing is the HTML-mandated strip of leading/trailing ASCII whitespace.
 * Throws if `base` has no scheme: a document URL is always absolute.
 */
export function resolveReference(base: string, reference: string): string {
  const b = parseReference(base);
  if (b.scheme === undefined) throw new Error(`base URI must be absolute: ${base}`);
  const r = parseReference(reference.replace(ASCII_WS_EDGES, ""));
  const t: Components = {
    scheme: undefined,
    authority: undefined,
    path: "",
    query: undefined,
    fragment: r.fragment,
  };

  if (r.scheme !== undefined) {
    t.scheme = r.scheme;
    t.authority = r.authority;
    t.path = removeDotSegments(r.path);
    t.query = r.query;
  } else {
    if (r.authority !== undefined) {
      t.authority = r.authority;
      t.path = removeDotSegments(r.path);
      t.query = r.query;
    } else {
      if (r.path === "") {
        t.path = b.path;
        t.query = r.query ?? b.query;
      } else {
        t.path = r.path.startsWith("/")
          ? removeDotSegments(r.path)
          : removeDotSegments(merge(b, r.path));
        t.query = r.query;
      }
      t.authority = b.authority;
    }
    t.scheme = b.scheme;
  }
  return recompose(t);
}

/** Drop the fragment (it is never sent to the server); nothing else is touched. */
export function stripFragment(uri: string): string {
  const hash = uri.indexOf("#");
  return hash === -1 ? uri : uri.slice(0, hash);
}

// ---------------------------------------------------------------------------------------------
// §6.2.2 syntax-based normalisation building blocks
// ---------------------------------------------------------------------------------------------

export interface Authority {
  userinfo: string | undefined;
  host: string;
  port: string | undefined;
}

/** Split an authority into userinfo, host (IP-literal kept in brackets) and port. */
export function parseAuthority(authority: string): Authority {
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? undefined : authority.slice(0, at);
  const hostport = at === -1 ? authority : authority.slice(at + 1);
  const m = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/s.exec(hostport);
  return { userinfo, host: m?.[1] ?? hostport, port: m?.[2] };
}

export function recomposeAuthority(a: Authority): string {
  return `${a.userinfo !== undefined ? `${a.userinfo}@` : ""}${a.host}${a.port !== undefined ? `:${a.port}` : ""}`;
}

const HEX = /^[0-9A-Fa-f]{2}$/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
/** Characters allowed to appear literally in a URI (unreserved, reserved, and "%"). */
const URI_CHAR = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]$/;
const encoder = new TextEncoder();

function encodeUtf8(ch: string): string {
  return Array.from(
    encoder.encode(ch),
    (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
}

/**
 * Percent-encoding normalisation (§6.2.2.1, §6.2.2.2): escapes of unreserved characters are
 * decoded, all other escapes get upper-case hex, and characters that may not appear in a URI
 * (non-ASCII, space, controls, `"<>\^`{|}`) are UTF-8 percent-encoded (the RFC 3987 IRI→URI
 * mapping), so "/ü" and "/%C3%BC" coincide. A "%" not followed by two hex digits is left as is.
 */
export function normalizePercentEncoding(s: string): string {
  let out = "";
  const chars = Array.from(s); // by code point
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
    out += URI_CHAR.test(ch) ? ch : encodeUtf8(ch);
  }
  return out;
}

/** Lower-case everything except the hex digits of %XX escapes (which stay upper-case). */
export function lowerCaseOutsideEscapes(s: string): string {
  return s.replace(/%[0-9A-F]{2}|[^%]+|%/g, (part) =>
    part.startsWith("%") ? part : part.toLowerCase(),
  );
}
