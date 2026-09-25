/**
 * Reference resolution exactly as RFC 3986 §5.2 defines it, and nothing else.
 *
 * WHATWG `new URL()` also normalises: it lower-cases scheme and host, drops default ports,
 * percent-encodes, turns "\" into "/", and so on. link_observations.resolved_url must not carry
 * any of that (canonicalisation belongs to the P0–P5 policies), so resolution is done here.
 *
 * The only preprocessing is the one HTML itself mandates for attribute URLs: leading and trailing
 * ASCII whitespace is stripped (HTML "parse a URL"). raw_href keeps the value exactly as written.
 */

interface Components {
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
  if (m === null)
    return {
      scheme: undefined,
      authority: undefined,
      path: ref,
      query: undefined,
      fragment: undefined,
    };
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
function recompose(c: Components): string {
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
