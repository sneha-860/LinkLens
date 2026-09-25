/** Media type from a Content-Type header ("text/html; charset=utf-8" → "text/html"). */
export function mediaType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "" ? null : type;
}

/**
 * Only HTML is parsed for links. A missing Content-Type is treated as non-HTML: we do not sniff,
 * so the stored fetch reflects exactly what the server declared.
 */
export function isHtml(contentType: string | null): boolean {
  const type = mediaType(contentType);
  return type === "text/html" || type === "application/xhtml+xml";
}

/** charset parameter of a Content-Type header, or null. */
export function charset(contentType: string | null): string | null {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
  return m?.[1] ?? null;
}

/** Decode bytes with the declared charset, falling back to UTF-8 for unknown labels. */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const label = charset(contentType) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
