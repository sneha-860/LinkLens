/** One CSV record with the physical line it starts on (1-based). */
export interface CsvRecord {
  readonly line: number;
  readonly fields: string[];
}

/**
 * RFC 4180 CSV: comma-separated, fields optionally in double quotes (a quote inside is doubled,
 * and quoted fields may contain commas and line breaks), CRLF or LF line ends. A leading UTF-8 BOM
 * is ignored; blank lines are skipped.
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const out: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let touched = false; // the current record has any content (for blank-line skipping)

  const endRecord = () => {
    fields.push(field);
    if (touched) out.push({ line: start, fields });
    fields = [];
    field = "";
    touched = false;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (c === "\n") line += 1;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      touched = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
      touched = true;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      endRecord();
      line += 1;
      start = line;
    } else {
      field += c;
      touched = true;
    }
  }
  if (quoted) throw new CsvError([`line ${start}: unterminated quoted field`]);
  if (touched || field !== "") endRecord();
  return out;
}

export class CsvError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `invalid analytics CSV: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`,
    );
  }
}

/** One analytics row, URLs exactly as written. */
export interface AnalyticsCsvRow {
  readonly sourceUrl: string;
  readonly targetUrl: string;
  readonly clicks: number;
  readonly lineNumber: number;
}

export const ANALYTICS_COLUMNS = ["source_url", "target_url", "clicks"] as const;

/**
 * An analytics export: a header naming source_url, target_url and clicks (any order, any case,
 * other columns ignored), then one row per link. clicks must be a non-negative integer and both
 * URLs non-empty; every problem is reported (with its line) and nothing is returned if any.
 * URLs are kept as written (trimmed of surrounding whitespace only).
 */
export function parseAnalyticsCsv(text: string): AnalyticsCsvRow[] {
  const records = parseCsv(text);
  const header = records[0];
  if (header === undefined) throw new CsvError(["empty file: expected a header row"]);
  const names = header.fields.map((f) => f.trim().toLowerCase());
  const col = Object.fromEntries(ANALYTICS_COLUMNS.map((c) => [c, names.indexOf(c)])) as Record<
    (typeof ANALYTICS_COLUMNS)[number],
    number
  >;
  const missing = ANALYTICS_COLUMNS.filter((c) => col[c] < 0);
  if (missing.length > 0) {
    throw new CsvError([`line ${header.line}: missing column(s) ${missing.join(", ")}`]);
  }

  const rows: AnalyticsCsvRow[] = [];
  const problems: string[] = [];
  for (const { line, fields } of records.slice(1)) {
    const get = (c: (typeof ANALYTICS_COLUMNS)[number]) => (fields[col[c]] ?? "").trim();
    const sourceUrl = get("source_url");
    const targetUrl = get("target_url");
    const raw = get("clicks");
    const clicks = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (sourceUrl === "") problems.push(`line ${line}: empty source_url`);
    if (targetUrl === "") problems.push(`line ${line}: empty target_url`);
    if (!Number.isSafeInteger(clicks)) {
      problems.push(`line ${line}: clicks must be a non-negative integer, got "${raw}"`);
    }
    rows.push({ sourceUrl, targetUrl, clicks, lineNumber: line });
  }
  if (problems.length > 0) throw new CsvError(problems);
  return rows;
}
