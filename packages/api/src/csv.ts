/** One RFC 4180 field: quoted when it contains a comma, quote, CR or LF. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A CSV document (header row, CRLF line ends) from rows and the columns to write. */
export function toCsv<T>(
  rows: readonly T[],
  columns: readonly [header: string, get: (row: T) => unknown][],
): string {
  const lines = [columns.map(([h]) => csvField(h)).join(",")];
  for (const r of rows) lines.push(columns.map(([, get]) => csvField(get(r))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
