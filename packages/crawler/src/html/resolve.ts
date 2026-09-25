/**
 * RFC 3986 reference resolution now lives in @linklens/core (`rfc3986`), shared with the
 * canonicalisation policies. Re-exported here for the crawler's existing imports.
 */
import { rfc3986 } from "@linklens/core";

export const { parseReference, removeDotSegments, resolveReference, stripFragment } = rfc3986;
