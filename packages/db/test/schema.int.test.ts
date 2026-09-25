import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type pg from "pg";
import { db as q, defaultConfig, discovery } from "@linklens/core";
import { asQueryable, createPool } from "../src/pool.js";
import { migrate } from "../src/migrate.js";
import { createTempDatabase, dropTempDatabase } from "./helpers.js";

let pool: pg.Pool;
let db: q.Queryable;

beforeAll(() => {
  pool = createPool(inject("databaseUrl"));
  db = asQueryable(pool);
});
afterAll(async () => {
  await pool.end();
});

/** Build a site → run → fetch chain for tests that need parent rows. */
async function seedRun() {
  const site = await q.insertSite(db, { rootUrl: "https://example.com/" });
  const run = await q.createRun(db, { siteId: site.id, config: defaultConfig });
  const fetch = await q.insertFetch(db, { runId: run.id, requestedUrl: "https://example.com/" });
  return { site, run, fetch };
}

/** Postgres SQLSTATE of a rejected promise. */
async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  throw new Error("expected the query to fail");
}

describe("migrations", () => {
  it("create every table", async () => {
    const { rows } = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      "artefacts",
      "discovery_observations",
      "fetch_bodies",
      "fetches",
      "link_observations",
      "pages",
      "pgmigrations",
      "runs",
      "sites",
    ]);
  });

  it("roll down cleanly and back up (on a separate database)", async () => {
    const url = await createTempDatabase();
    try {
      const all = await migrate(url, "up");
      expect(all.length).toBeGreaterThanOrEqual(2);
      expect(await migrate(url, "down", Infinity)).toEqual([...all].reverse());
      const p = createPool(url);
      try {
        const { rows } = await p.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'",
        );
        expect(rows).toEqual([]);
      } finally {
        await p.end();
      }
      expect(await migrate(url, "up")).toEqual(all);
    } finally {
      await dropTempDatabase(url);
    }
  });
});

describe("typed helpers round-trip", () => {
  it("sites and runs", async () => {
    const site = await q.insertSite(db, {
      rootUrl: "https://example.com/",
      architectureClass: "blog",
    });
    expect(typeof site.id).toBe("number");
    expect(site.createdAt).toBeInstanceOf(Date);
    expect(await q.getSite(db, site.id)).toEqual(site);
    expect(await q.getSite(db, 999_999_999)).toBeNull();

    const run = await q.createRun(db, { siteId: site.id, config: defaultConfig });
    expect(run).toMatchObject({ siteId: site.id, status: "pending", seed: 42, finishedAt: null });
    expect(run.config).toEqual(defaultConfig);

    const running = await q.setRunStatus(db, run.id, "running");
    expect(running.finishedAt).toBeNull();
    const done = await q.setRunStatus(db, run.id, "completed");
    expect(done.status).toBe("completed");
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(await q.getRun(db, run.id)).toEqual(done);
  });

  it("fetches and pages preserve jsonb arrays and objects", async () => {
    const { run } = await seedRun();
    const fetch = await q.insertFetch(db, {
      runId: run.id,
      requestedUrl: "http://Example.com/a",
      finalUrl: "https://example.com/a/",
      statusCode: 200,
      redirectChain: [{ url: "http://Example.com/a", statusCode: 301 }],
      headers: { "content-type": "text/html" },
      contentType: "text/html",
      bytes: 1234,
    });
    expect(fetch.redirectChain).toEqual([{ url: "http://Example.com/a", statusCode: 301 }]);
    expect(fetch.headers).toEqual({ "content-type": "text/html" });

    const page = await q.insertPage(db, {
      runId: run.id,
      fetchId: fetch.id,
      url: "https://example.com/a/",
      title: "A",
      headings: [{ level: 2, text: "Intro" }],
      paragraphs: ["one", "two"],
    });
    expect(page.headings).toEqual([{ level: 2, text: "Intro" }]);
    expect(page.paragraphs).toEqual(["one", "two"]);
    expect(await q.listPages(db, run.id)).toEqual([page]);
    expect((await q.listFetches(db, run.id)).map((f) => f.id)).toContain(fetch.id);
  });

  it("pages.fetch_id is unique", async () => {
    const { run, fetch } = await seedRun();
    await q.insertPage(db, { runId: run.id, fetchId: fetch.id, url: "https://example.com/" });
    expect(
      await sqlState(
        q.insertPage(db, { runId: run.id, fetchId: fetch.id, url: "https://example.com/" }),
      ),
    ).toBe("23505");
  });

  it("link observations store raw_href verbatim, in insertion order", async () => {
    const { run, fetch } = await seedRun();
    const hrefs = ["  ../About?utm=x#top ", "HTTPS://EXAMPLE.COM/Blog/", "mailto:a@b.c"];
    const inserted = await q.insertLinkObservations(
      db,
      hrefs.map((rawHref, i) => ({
        runId: run.id,
        sourceFetchId: fetch.id,
        rawHref,
        positionIndex: i,
      })),
    );
    expect(inserted.map((l) => l.rawHref)).toEqual(hrefs);
    expect((await q.listLinkObservations(db, run.id)).map((l) => l.rawHref)).toEqual(hrefs);
  });

  it("bulk link inserts span multiple statements", async () => {
    const { run, fetch } = await seedRun();
    const n = 7000; // > 65535 / 10 columns, so two chunks
    const rows = Array.from({ length: n }, (_, i) => ({
      runId: run.id,
      sourceFetchId: fetch.id,
      rawHref: `/p/${i}`,
      positionIndex: i,
    }));
    const inserted = await q.insertLinkObservations(db, rows);
    expect(inserted).toHaveLength(n);
    const listed = await q.listLinkObservations(db, run.id);
    expect(listed.map((l) => l.positionIndex)).toEqual(rows.map((r) => r.positionIndex));
  });

  it("discovery observations accept every channel and filter by channel", async () => {
    const { run } = await seedRun();
    await q.insertDiscoveryObservations(
      db,
      discovery.DISCOVERY_CHANNELS.map((channel) => ({
        runId: run.id,
        channel,
        url: `https://example.com/${channel}`,
        sourceDocument: "https://example.com/sitemap.xml",
      })),
    );
    expect(await q.listDiscoveryObservations(db, run.id)).toHaveLength(
      discovery.DISCOVERY_CHANNELS.length,
    );
    const llms = await q.listDiscoveryObservations(db, run.id, "llms_txt");
    expect(llms.map((d) => d.url)).toEqual(["https://example.com/llms_txt"]);
  });

  it("rejects an unknown discovery channel", async () => {
    const { run } = await seedRun();
    const bad = { runId: run.id, channel: "twitter" as never, url: "https://example.com/" };
    expect(await sqlState(q.insertDiscoveryObservations(db, [bad]))).toBe("23514");
  });

  it("artefacts carry run id and policy version and filter on both", async () => {
    const { run } = await seedRun();
    await q.insertArtefact(db, {
      runId: run.id,
      policyVersion: "P0",
      kind: "pagerank",
      payload: { a: 0.5 },
    });
    await q.insertArtefact(db, {
      runId: run.id,
      policyVersion: "P2",
      kind: "pagerank",
      payload: { a: 0.4 },
    });
    await q.insertArtefact(db, {
      runId: run.id,
      policyVersion: "P2",
      kind: "scc",
      payload: [[1, 2]],
    });

    expect(await q.listArtefacts(db, run.id)).toHaveLength(3);
    const p2pr = await q.listArtefacts(db, run.id, { policyVersion: "P2", kind: "pagerank" });
    expect(p2pr.map((a) => a.payload)).toEqual([{ a: 0.4 }]);
    expect(
      await sqlState(
        q.insertArtefact(db, { runId: run.id, policyVersion: "", kind: "x", payload: 1 }),
      ),
    ).toBe("23514");
  });

  it("numbers attempts and exposes each URL's last attempt via final_fetches", async () => {
    const { run } = await seedRun(); // seeds one fetch of https://example.com/ (attempt 1)
    const u = "https://example.com/flaky";
    await q.insertFetch(db, { runId: run.id, requestedUrl: u, statusCode: 503, attempt: 1 });
    await q.insertFetch(db, { runId: run.id, requestedUrl: u, statusCode: 503, attempt: 2 });
    const last = await q.insertFetch(db, {
      runId: run.id,
      requestedUrl: u,
      statusCode: 200,
      attempt: 3,
    });
    expect(last.attempt).toBe(3);
    const final = await q.listFinalFetches(db, run.id);
    expect(final.map((f) => [f.requestedUrl, f.attempt, f.statusCode])).toEqual([
      ["https://example.com/", 1, null],
      [u, 3, 200],
    ]);
    expect(await sqlState(q.insertFetch(db, { runId: run.id, requestedUrl: u, attempt: 0 }))).toBe(
      "23514",
    );
  });

  it("lists a URL's fetch history across runs, newest first", async () => {
    const u = `https://history.example/robots.txt?${Date.now()}`;
    const a = await seedRun();
    const b = await seedRun();
    await q.insertFetch(db, {
      runId: a.run.id,
      requestedUrl: u,
      fetchedAt: new Date("2026-01-01"),
    });
    await q.insertFetch(db, {
      runId: b.run.id,
      requestedUrl: u,
      fetchedAt: new Date("2026-02-01"),
    });
    const history = await q.listFetchHistory(db, u, 10);
    expect(history.map((f) => f.runId)).toEqual([b.run.id, a.run.id]);
    expect(await q.listFetchHistory(db, u, 1)).toHaveLength(1);
  });

  it("stores raw bodies byte-for-byte", async () => {
    const { run, fetch } = await seedRun();
    const bytes = Buffer.from([0x3c, 0x70, 0x3e, 0xe2, 0x9c, 0x93, 0x00, 0xff]);
    await q.insertFetchBody(db, {
      fetchId: fetch.id,
      runId: run.id,
      body: bytes,
      truncated: true,
      sha256: "b".repeat(64),
    });
    const row = await q.getFetchBody(db, fetch.id);
    expect(Buffer.from(row?.body ?? [])).toEqual(bytes);
    expect(row).toMatchObject({ runId: run.id, truncated: true, sha256: "b".repeat(64) });
    expect(await q.getFetchBody(db, 999_999_999)).toBeNull();
    expect(
      await sqlState(
        q.insertFetchBody(db, {
          fetchId: fetch.id,
          runId: run.id,
          body: bytes,
          truncated: false,
          sha256: "x",
        }),
      ),
    ).toBe("23514");
  });

  it("enforces foreign keys", async () => {
    expect(
      await sqlState(
        q.insertFetch(db, { runId: 999_999_999, requestedUrl: "https://example.com/" }),
      ),
    ).toBe("23503");
  });
});

describe("append-only enforcement", () => {
  const RESTRICT_VIOLATION = "23001";

  const textColumn = {
    link_observations: "raw_href",
    discovery_observations: "url",
    fetch_bodies: "sha256",
  } as const;

  for (const table of ["link_observations", "discovery_observations", "fetch_bodies"] as const) {
    describe(table, () => {
      let runId: number;

      beforeAll(async () => {
        const { run, fetch } = await seedRun();
        runId = run.id;
        await q.insertLinkObservations(db, [
          { runId, sourceFetchId: fetch.id, rawHref: "/x", positionIndex: 0 },
        ]);
        await q.insertDiscoveryObservations(db, [
          { runId, channel: "xml_sitemap", url: "https://example.com/x" },
        ]);
        await q.insertFetchBody(db, {
          fetchId: fetch.id,
          runId,
          body: Buffer.from("<p>x</p>"),
          truncated: false,
          sha256: "a".repeat(64),
        });
      });

      it("blocks UPDATE", async () => {
        const col = textColumn[table];
        expect(
          await sqlState(
            db.query(`UPDATE ${table} SET ${col} = 'changed' WHERE run_id = $1`, [runId]),
          ),
        ).toBe(RESTRICT_VIOLATION);
      });

      it("blocks DELETE", async () => {
        expect(await sqlState(db.query(`DELETE FROM ${table} WHERE run_id = $1`, [runId]))).toBe(
          RESTRICT_VIOLATION,
        );
      });

      it("blocks TRUNCATE", async () => {
        expect(await sqlState(db.query(`TRUNCATE ${table}`))).toBe(RESTRICT_VIOLATION);
      });

      it("leaves the rows intact after the rejected attempts", async () => {
        const { rows } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE run_id = $1`,
          [runId],
        );
        expect(rows[0]?.n).toBe(1);
      });
    });
  }

  it("allows the cancelled status and stamps finished_at", async () => {
    const { run } = await seedRun();
    const cancelled = await q.setRunStatus(db, run.id, "cancelled");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).toBeInstanceOf(Date);
  });

  it("finds a site by its exact root_url only", async () => {
    const site = await q.insertSite(db, { rootUrl: "https://exact.example/Path" });
    expect((await q.getSiteByRootUrl(db, "https://exact.example/Path"))?.id).toBe(site.id);
    expect(await q.getSiteByRootUrl(db, "https://exact.example/path")).toBeNull();
  });

  it("does not affect mutable tables", async () => {
    const { run } = await seedRun();
    await expect(q.setRunStatus(db, run.id, "failed")).resolves.toMatchObject({ status: "failed" });
  });
});
