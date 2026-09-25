import { describe, expect, it } from "vitest";
import { CsvError, parseAnalyticsCsv, parseCsv } from "./csv.js";

describe("parseCsv (RFC 4180)", () => {
  it("handles quotes, doubled quotes, commas and line breaks inside quotes, CRLF and a BOM", () => {
    const text = '﻿a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z\n\nlast,1';
    expect(parseCsv(text)).toEqual([
      { line: 1, fields: ["a", "b"] },
      { line: 2, fields: ["x, y", 'say "hi"'] },
      { line: 3, fields: ["multi\nline", "z"] },
      { line: 6, fields: ["last", "1"] },
    ]);
  });

  it("keeps empty fields and rejects an unterminated quote", () => {
    expect(parseCsv("a,,c\n")).toEqual([{ line: 1, fields: ["a", "", "c"] }]);
    expect(() => parseCsv('a,"b\n')).toThrow(CsvError);
  });
});

describe("parseAnalyticsCsv", () => {
  it("reads the three columns in any order and case, ignoring others", () => {
    const rows = parseAnalyticsCsv(
      "Clicks,extra,TARGET_URL,source_url\n12,x,https://s.test/b,https://s.test/a\n0,,/c, /a \n",
    );
    expect(rows).toEqual([
      { sourceUrl: "https://s.test/a", targetUrl: "https://s.test/b", clicks: 12, lineNumber: 2 },
      { sourceUrl: "/a", targetUrl: "/c", clicks: 0, lineNumber: 3 },
    ]);
  });

  it("keeps URLs as written (no normalisation)", () => {
    const [row] = parseAnalyticsCsv(
      "source_url,target_url,clicks\nHTTPS://S.TEST/A?utm_source=x,https://s.test/%7Eb,1",
    );
    expect(row).toMatchObject({
      sourceUrl: "HTTPS://S.TEST/A?utm_source=x",
      targetUrl: "https://s.test/%7Eb",
    });
  });

  it("reports every bad row with its line, and returns nothing", () => {
    const text = "source_url,target_url,clicks\n/a,/b,1\n/a,/b,-3\n,/b,2\n/a,/b,1.5\n/a,/b,lots";
    try {
      parseAnalyticsCsv(text);
      expect.unreachable();
    } catch (e) {
      expect((e as CsvError).problems).toEqual([
        'line 3: clicks must be a non-negative integer, got "-3"',
        "line 4: empty source_url",
        'line 5: clicks must be a non-negative integer, got "1.5"',
        'line 6: clicks must be a non-negative integer, got "lots"',
      ]);
    }
  });

  it("requires a header with every column", () => {
    expect(() => parseAnalyticsCsv("")).toThrow(/empty file/);
    expect(() => parseAnalyticsCsv("source_url,clicks\n/a,1")).toThrow(
      /missing column\(s\) target_url/,
    );
  });

  it("accepts a header-only file", () => {
    expect(parseAnalyticsCsv("source_url,target_url,clicks\n")).toEqual([]);
  });
});
