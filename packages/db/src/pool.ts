import pg from "pg";
import type { db } from "@linklens/core";

const INT8_OID = 20;

/** Parse Postgres bigint ids to number, refusing values that would lose precision. */
export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new RangeError(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
}

// Scoped to our pools (not the global pg.types registry).
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === INT8_OID && format !== "binary"
      ? parseInt8
      : pg.types.getTypeParser(oid, format)) as pg.CustomTypesConfig["getTypeParser"],
};

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, types });
}

/** Adapt a pg Pool or Client to core's driver-agnostic `Queryable`. */
export function asQueryable(client: pg.Pool | pg.ClientBase): db.Queryable {
  return {
    async query<R>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as R[] };
    },
  };
}
