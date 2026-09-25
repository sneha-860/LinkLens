import { describe, expect, it } from "vitest";
import { buildInsert, PG_MAX_PARAMS, type ColumnSpec } from "./sql.js";

interface Row {
  a: number;
  b: string[];
}
const spec: ColumnSpec<Row>[] = [
  { column: "a", get: (r) => r.a },
  { column: "b", get: (r) => r.b, json: true },
];

describe("buildInsert", () => {
  it("builds a multi-row insert with jsonb casts and stringified json", () => {
    const [stmt, ...rest] = buildInsert(
      "t",
      spec,
      [
        { a: 1, b: ["x"] },
        { a: 2, b: [] },
      ],
      "id",
    );
    expect(rest).toHaveLength(0);
    expect(stmt?.text).toBe(
      "INSERT INTO t (a, b) VALUES ($1, $2::jsonb), ($3, $4::jsonb) RETURNING id",
    );
    expect(stmt?.values).toEqual([1, '["x"]', 2, "[]"]);
  });

  it("returns no statements for no rows", () => {
    expect(buildInsert("t", spec, [], "id")).toEqual([]);
  });

  it("chunks so no statement exceeds the parameter limit", () => {
    const perChunk = Math.floor(PG_MAX_PARAMS / spec.length);
    const rows = Array.from({ length: perChunk + 5 }, (_, i) => ({ a: i, b: [] }));
    const stmts = buildInsert("t", spec, rows, "id");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]?.values).toHaveLength(perChunk * spec.length);
    expect(stmts[1]?.values).toHaveLength(5 * spec.length);
    expect(stmts[1]?.text.startsWith("INSERT INTO t (a, b) VALUES ($1, $2::jsonb)")).toBe(true);
  });

  it("rejects an empty column list", () => {
    expect(() => buildInsert("t", [], [{}], "id")).toThrow();
  });
});
