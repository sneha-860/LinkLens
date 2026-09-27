import { describe, expect, it } from "vitest";
import {
  CHANNELS_COLUMNS,
  E3_COLUMNS,
  E4_COLUMNS,
  E4_PAGES_COLUMNS,
  E5_CATEGORIES_COLUMNS,
  E5_COLUMNS,
  E5_DISAGREEMENTS_COLUMNS,
  E6_COLUMNS,
  METRICS_COLUMNS,
  POLICY_PAIRS_COLUMNS,
  SITES_COLUMNS,
  STAGES_COLUMNS,
  csvCell,
  toCsv,
} from "./csv.js";

describe("csvCell", () => {
  it("quotes only when needed (RFC 4180)", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(0.125)).toBe("0.125");
    expect(csvCell(true)).toBe("1");
    expect(csvCell(false)).toBe("0");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("writes the header and one CRLF-terminated row per record", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          { a: 1, b: "x,y" },
          { a: null, b: "" },
        ],
      ),
    ).toBe('a,b\r\n1,"x,y"\r\n,\r\n');
  });

  it("keeps the column contract with analysis/", () => {
    // analysis/linklens_analysis/corpus.py checks the same names.
    expect(METRICS_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "run_id",
      "policy",
      "policy_version",
      "is_audit_policy",
      "metric",
      "value",
    ]);
    expect(SITES_COLUMNS.slice(0, 7)).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "url",
      "notes",
      "status",
      "run_id",
    ]);
    expect(STAGES_COLUMNS).toContain("duration_ms");
    expect(CHANNELS_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "run_id",
      "policy",
      "policy_version",
      "channel",
      "metric",
      "value",
    ]);
    expect(E6_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "run_id",
      "policy",
      "repeat",
      "seed",
      "method",
      "metric",
      "value",
    ]);
    expect(E5_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "run_id",
      "policy",
      "policy_version",
      "metric",
      "value",
    ]);
    expect(E5_CATEGORIES_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "policy",
      "kind",
      "category",
      "count",
      "share",
      "large",
      "explanation",
      "examples",
    ]);
    expect(E5_DISAGREEMENTS_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "policy",
      "kind",
      "node",
      "category",
      "detail",
    ]);
    expect(E4_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "run_a",
      "run_b",
      "comparison",
      "metric",
      "value",
    ]);
    expect(E4_PAGES_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "node",
      "status",
      "cause",
      "reason",
    ]);
    expect(E3_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "run_id",
      "policy",
      "policy_version",
      "k",
      "method",
      "metric",
      "value",
    ]);
    expect(POLICY_PAIRS_COLUMNS).toEqual([
      "batch_id",
      "site_id",
      "architecture_class",
      "run_id",
      "policy_a",
      "policy_b",
      "top_k",
      "metric",
      "value",
    ]);
  });
});
