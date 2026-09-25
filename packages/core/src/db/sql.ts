/** Postgres wire protocol limit on bind parameters per statement. */
export const PG_MAX_PARAMS = 65535;

export interface ColumnSpec<T> {
  /** SQL column name (snake_case). */
  readonly column: string;
  /** Reads the value from the input object. */
  readonly get: (row: T) => unknown;
  /** jsonb columns are JSON.stringify'd and cast, so JS arrays are not sent as Postgres arrays. */
  readonly json?: boolean;
}

export interface Statement {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * Build one or more multi-row INSERT ... RETURNING statements, chunked so no statement exceeds
 * PG_MAX_PARAMS bind parameters. Pure: produces SQL text and values only.
 */
export function buildInsert<T>(
  table: string,
  columns: readonly ColumnSpec<T>[],
  rows: readonly T[],
  returning: string,
): Statement[] {
  if (columns.length === 0) throw new Error("buildInsert: no columns");
  const rowsPerChunk = Math.floor(PG_MAX_PARAMS / columns.length);
  const colList = columns.map((c) => c.column).join(", ");
  const statements: Statement[] = [];

  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    const chunk = rows.slice(start, start + rowsPerChunk);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((c) => {
        const raw = c.get(row);
        values.push(c.json === true ? JSON.stringify(raw) : raw);
        return c.json === true ? `$${values.length}::jsonb` : `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    statements.push({
      text: `INSERT INTO ${table} (${colList}) VALUES ${tuples.join(", ")} RETURNING ${returning}`,
      values,
    });
  }
  return statements;
}
