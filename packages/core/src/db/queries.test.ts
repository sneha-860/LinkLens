import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import {
  createRun,
  getSite,
  insertArtefact,
  insertLinkObservations,
  listArtefacts,
  listDiscoveryObservations,
  setRunStatus,
} from "./queries.js";
import type { Queryable } from "./types.js";

interface Call {
  text: string;
  values: readonly unknown[];
}

/** Records every query and returns the given rows. */
function fakeDb(rows: unknown[] = [{ id: 1 }]): Queryable & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query<R>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: rows as R[] });
    },
  };
}

describe("db query helpers", () => {
  it("createRun stores config as JSON and defaults seed to config.randomSeed", async () => {
    const db = fakeDb();
    await createRun(db, { siteId: 7, config: defaultConfig });
    expect(db.calls[0]?.values).toEqual([7, JSON.stringify(defaultConfig), 42, "pending"]);
    expect(db.calls[0]?.text).toContain("$2::jsonb");
  });

  it("createRun honours an explicit seed and status", async () => {
    const db = fakeDb();
    await createRun(db, { siteId: 7, config: defaultConfig, seed: 9, status: "running" });
    expect(db.calls[0]?.values.slice(2)).toEqual([9, "running"]);
  });

  it("setRunStatus stamps finished_at only for terminal statuses (in SQL)", async () => {
    const db = fakeDb();
    await setRunStatus(db, 3, "completed");
    expect(db.calls[0]?.text).toMatch(/CASE WHEN \$2 = ANY\(\$3::text\[\]\)/);
    expect(db.calls[0]?.values).toEqual([3, "completed", ["completed", "failed", "cancelled"]]);
  });

  it("getSite returns null when no row matches", async () => {
    expect(await getSite(fakeDb([]), 1)).toBeNull();
  });

  it("insertLinkObservations sends nothing for an empty batch", async () => {
    const db = fakeDb();
    expect(await insertLinkObservations(db, [])).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("insertLinkObservations keeps raw_href verbatim and nulls missing optionals", async () => {
    const db = fakeDb();
    await insertLinkObservations(db, [
      { runId: 1, sourceFetchId: 2, rawHref: "  ../A?b=1#x ", positionIndex: 0 },
    ]);
    expect(db.calls[0]?.values).toEqual([
      1,
      2,
      "  ../A?b=1#x ",
      null,
      null,
      null,
      null,
      null,
      null,
      0,
    ]);
  });

  it("insertArtefact requires policy version and run id and stringifies payload", async () => {
    const db = fakeDb();
    await insertArtefact(db, { runId: 5, policyVersion: "P2", kind: "pagerank", payload: [0.5] });
    expect(db.calls[0]?.values).toEqual([5, "P2", "pagerank", "[0.5]"]);
  });

  it("list filters pass null when unset", async () => {
    const db = fakeDb([]);
    await listArtefacts(db, 5);
    await listDiscoveryObservations(db, 5, "llms_txt");
    expect(db.calls[0]?.values).toEqual([5, null, null]);
    expect(db.calls[1]?.values).toEqual([5, "llms_txt"]);
  });
});
