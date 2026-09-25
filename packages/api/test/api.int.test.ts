import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Redis } from "ioredis";
import { createPool } from "@linklens/db";
import type { Embedder, EmbedRequest, EmbeddingOptions } from "@linklens/embeddings";
import { startFixtureServer } from "@linklens/crawler/testing";
import { createApp } from "../src/app.js";
import { PipelineRunner, STAGES, type Stage } from "../src/pipeline.js";

const CONFIG = {
  userAgent: "LinkLensBot/0.1 (+https://linklens.test/bot)",
  crawlDelayMs: 0,
  fetchTimeoutMs: 300,
  retryBackoffMs: 50,
  maxRedirects: 3,
};

/** Deterministic 16-d "embeddings": a character histogram (no model, no download). */
function stubEmbedder(options: EmbeddingOptions): Embedder {
  return {
    options,
    embed: async (requests: readonly EmbedRequest[]) => {
      const vectors = requests.map(({ title, body }) => {
        const v = new Float32Array(16);
        for (const c of `${title} ${body}`.toLowerCase())
          v[c.charCodeAt(0) % 16] = (v[c.charCodeAt(0) % 16] ?? 0) + 1;
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
      return {
        vectors,
        keys: requests.map((_, i) => `stub:${i}`),
        dimensions: 16,
        hits: 0,
        misses: requests.length,
      };
    },
  };
}

let pool: pg.Pool;
let redis: Redis;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let runner: PipelineRunner;
let app: ReturnType<typeof createApp>;
let cacheDir: string;
const prefix = `linklens_api_${randomBytes(4).toString("hex")}`;
const log: string[] = [];

// Test hooks: hold the next crawl until the SSE stream is open; fail a stage once.
let crawlGate: { promise: Promise<void>; release: () => void } | null = null;
const failOnce = new Map<number, Stage>();
let failNext: Stage | null = null;

beforeAll(async () => {
  pool = createPool(inject("databaseUrl"));
  redis = new Redis(inject("redisUrl"));
  server = await startFixtureServer();
  cacheDir = await mkdtemp(join(tmpdir(), "linklens-api-"));
  runner = new PipelineRunner({
    pool,
    redisUrl: inject("redisUrl"),
    prefix,
    cacheDir,
    embedder: stubEmbedder,
    logger: { info: (m) => log.push(m), error: (m) => log.push(`ERROR ${m}`) },
    beforeStage: async (runId, stage) => {
      if (stage === "crawl" && crawlGate !== null) await crawlGate.promise;
      if (failNext !== null && !failOnce.has(runId)) failOnce.set(runId, failNext);
      if (failOnce.get(runId) === stage) {
        failOnce.set(runId, "never" as Stage);
        failNext = null;
        throw new Error(`injected failure at ${stage}`);
      }
    },
  });
  app = createApp({ service: runner, heartbeatMs: 1_000 });
});

afterAll(async () => {
  await runner.close();
  await server.close();
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
  await pool.end();
  await rm(cacheDir, { recursive: true, force: true });
});

/** GET an SSE stream to its end and parse the events. */
async function readEvents(
  path: string,
): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const res = await request(app)
    .get(path)
    .buffer(true)
    .parse((r, cb) => {
      let text = "";
      r.setEncoding("utf8");
      r.on("data", (c: string) => (text += c));
      r.on("end", () => cb(null, text));
    });
  expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
  return (res.body as string)
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((b) => {
      const [e, d] = b.split("\n");
      return { event: (e as string).slice(7), data: JSON.parse((d as string).slice(6)) };
    });
}

async function waitFor(id: number, statuses: string[]): Promise<Record<string, unknown>> {
  for (;;) {
    const res = await request(app).get(`/audits/${id}`);
    if (statuses.includes(res.body.status) && !runner.isActive(id)) return res.body;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("an audit through the whole pipeline", () => {
  let id: number;
  let o: string;
  let events: { event: string; data: Record<string, unknown> }[];

  beforeAll(async () => {
    o = server.origin;
    let release: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    crawlGate = { promise, release: () => release() };
    const res = await request(app)
      .post("/audits")
      .send({ url: `${o}/`, policy: "P0", options: { workers: 1, config: CONFIG } });
    expect(res.status).toBe(202);
    id = res.body.id;
    const stream = readEvents(`/audits/${id}/events`);
    while (runner.listenerCount("event") === 0) await new Promise((r) => setTimeout(r, 10));
    crawlGate.release();
    crawlGate = null;
    events = await stream;
  });

  it("streams a snapshot, every stage in order, crawl progress and done", () => {
    expect(events[0]?.event).toBe("snapshot");
    const stages = events.filter((e) => e.event === "stage");
    expect(
      stages.filter((e) => e.data["status"] === "completed").map((e) => e.data["stage"]),
    ).toEqual([...STAGES]);
    // The stream opened while the crawl was already running (the snapshot shows it); every later
    // stage is announced as it starts.
    const snapshot = events[0]?.data as { stages: { stage: string; status: string }[] };
    expect(snapshot.stages[0]).toMatchObject({ stage: "crawl", status: "running" });
    expect(
      stages.filter((e) => e.data["status"] === "running").map((e) => e.data["stage"]),
    ).toEqual(STAGES.slice(1));
    for (const e of stages.filter((x) => x.data["status"] === "completed")) {
      expect(e.data["durationMs"]).toBeGreaterThanOrEqual(0);
    }
    expect(events.filter((e) => e.event === "progress").length).toBeGreaterThan(5);
    expect(events.at(-1)).toMatchObject({ event: "done", data: { status: "completed" } });
    expect(log.some((l) => /\] text completed in \d+ ms/.test(l))).toBe(true);
  });

  it("reports status, progress and every stage's duration", async () => {
    const res = await request(app).get(`/audits/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      url: `${o}/`,
      policy: "P0",
      status: "completed",
      active: false,
      currentStage: null,
      progress: { completedStages: STAGES.length, totalStages: STAGES.length, fraction: 1 },
      crawl: { status: "completed" },
    });
    expect(res.body.crawl.urlsFetched).toBeGreaterThan(10);
    expect(res.body.stages.map((s: { stage: string }) => s.stage)).toEqual([...STAGES]);
    for (const s of res.body.stages) expect(s).toMatchObject({ status: "completed", error: null });
    const extract = res.body.stages.find((s: { stage: string }) => s.stage === "extract");
    expect(extract.detail.pages).toBeGreaterThan(5);
    expect(
      res.body.stages.find((s: { stage: string }) => s.stage === "rescue").detail,
    ).toMatchObject({ orphans: 5 });
  });

  it("stores every stage's artefacts with the policy version", async () => {
    const { rows } = await pool.query<{ kind: string; policy_version: string }>(
      "SELECT DISTINCT kind, policy_version FROM artefacts WHERE run_id = $1 ORDER BY kind",
      [id],
    );
    expect(rows.map((r) => r.kind)).toEqual(
      expect.arrayContaining([
        "extraction-summary",
        "canonicalisation",
        "link-graph",
        "discovery-reconciliation",
        "structural-audit",
        "text-representation",
        "ref-matrix",
        "cosine-matrix",
        "prominence",
        "diagnosis",
        "fix-candidates",
        "counterfactual",
        "donor-effort",
        "fix-ranking",
        "orphan-rescue",
        "explanations",
      ]),
    );
    expect(new Set(rows.map((r) => r.policy_version))).toEqual(new Set(["P0@1.0.0"]));
  });

  it("lists audits", async () => {
    const res = await request(app).get("/audits");
    expect(res.body.audits[0]).toMatchObject({
      id,
      url: `${o}/`,
      status: "completed",
      policy: "P0",
    });
  });

  it("summarises the audit", async () => {
    const res = await request(app).get(`/audits/${id}/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: "completed", discovery: { orphans: 5 } });
    expect(res.body.pages).toBeGreaterThan(5);
    expect(res.body.graph.nodes).toBeGreaterThan(5);
    expect(res.body.issues.total).toBeGreaterThan(0);
    expect(res.body.diagnosis.pairs).toBeGreaterThan(0);
  });

  it("serves the graph under the audit's policy, and derives another policy on demand", async () => {
    const own = await request(app).get(`/audits/${id}/graph`);
    expect(own.body).toMatchObject({ policy: "P0", policyVersion: "P0@1.0.0" });
    expect(own.body.graph.nodes.length).toBe(own.body.graph.attributes.nodes);
    const p3 = await request(app).get(`/audits/${id}/graph?policy=P3`);
    expect(p3.body).toMatchObject({ policy: "P3", policyVersion: "P3@1.0.0" });
    expect(p3.body.graph.attributes.nodes).toBeLessThan(own.body.graph.attributes.nodes);
  });

  it("filters issues by type and severity", async () => {
    const deep = await request(app).get(`/audits/${id}/issues?type=deep-page`);
    expect(deep.body.issues.map((i: { node: string }) => i.node.replace(o, "")).sort()).toEqual([
      "/deep/4.html",
      "/deep/5.html",
      "/deep/6.html",
    ]);
    const high = await request(app).get(`/audits/${id}/issues?severity=high`);
    for (const i of high.body.issues) expect(i.severity).toBe("high");
  });

  it("serves the diagnosis with a sentence per case", async () => {
    const res = await request(app).get(`/audits/${id}/diagnosis`);
    expect(res.body.diagnoses.length).toBe(
      res.body.counts.v1 + res.body.counts.v2 + res.body.counts.v3 + res.body.counts.v4,
    );
    for (const d of res.body.diagnoses) expect(d.explanation).toContain(`(${d.case})`);
    const v2 = await request(app).get(`/audits/${id}/diagnosis?case=v2`);
    for (const d of v2.body.diagnoses) expect(d.case).toBe("v2");
  });

  it("returns the top k fixes with explanations, per σ variant, globally or per target", async () => {
    const res = await request(app).get(`/audits/${id}/fixes`);
    expect(res.body).toMatchObject({ sigma: "refGateCosine", k: 10, scope: "global" });
    expect(res.body.fixes.length).toBeLessThanOrEqual(10);
    res.body.fixes.forEach((f: { rank: number; explanation: { sentence: string } }, i: number) => {
      expect(f.rank).toBe(i + 1);
      expect(f.explanation.sentence.length).toBeGreaterThan(0);
    });
    const refOnly = await request(app).get(`/audits/${id}/fixes?sigma=refOnly&k=25&scope=target`);
    expect(refOnly.body).toMatchObject({ sigma: "refOnly", k: 25, scope: "target" });
    for (const t of refOnly.body.targets) {
      expect(t.fixes.length).toBeLessThanOrEqual(25);
      for (const f of t.fixes) expect(f.sigma).toBe(f.ref);
    }
    // The refOnly ranking was computed on demand and stored; asking again reuses it.
    const again = await request(app).get(`/audits/${id}/fixes?sigma=refOnly&k=50`);
    expect(again.body.artefactId).toBe(refOnly.body.artefactId);
  });

  it("lists the orphans with rescue donors and the channels that revealed them", async () => {
    const res = await request(app).get(`/audits/${id}/orphans`);
    const byPath = new Map(
      res.body.orphans.map((x: { node: string }) => [x.node.replace(o, ""), x]),
    );
    expect([...byPath.keys()].sort()).toEqual([
      "/html-only.html",
      "/llms-orphan.html",
      "/orphan.html",
      "/rss-orphan.html",
      "/sitemap-orphan.html",
    ]);
    expect(byPath.get("/orphan.html")).toMatchObject({ revealedBy: ["xml_sitemap"] });
    const donor = (
      byPath.get("/orphan.html") as {
        donors: { donor: string; explanation: { lines: string[] } }[];
      }
    ).donors[0];
    expect(donor?.donor).toBe(`${o}/about.html`);
    expect(donor?.explanation.lines[0]).toContain("found only via the XML sitemap");
  });

  it("compares the six policies on the run (sizes, Spearman of PageRank, depth shift)", async () => {
    const res = await request(app).get(`/audits/${id}/sensitivity`);
    expect(res.body).toMatchObject({
      baselinePolicy: "P0",
      k: 10,
      sigma: "refGateCosine",
      fixesJob: null,
    });
    const rows = res.body.policies as Record<string, unknown>[];
    expect(rows.map((p) => p["policy"])).toEqual(["P0", "P1", "P2", "P3", "P4", "P5"]);
    const nodes = rows.map((p) => p["nodes"] as number);
    for (let i = 1; i < nodes.length; i++)
      expect(nodes[i]).toBeLessThanOrEqual(nodes[i - 1] as number);
    // The baseline against itself.
    expect(rows[0]).toMatchObject({
      pagerankSpearman: 1,
      meanDepthShift: 0,
      meanAbsDepthShift: 0,
      topFixesJaccard: 1,
    });
    for (const r of rows.slice(1)) {
      expect(r["pagerankSpearman"]).toBeGreaterThan(0.5);
      expect(r["topFixesJaccard"]).toBeNull(); // no ranking under that policy yet
    }
    const bad = await request(app).get(`/audits/${id}/sensitivity?k=7`);
    expect(bad.status).toBe(400);
  });

  it("ranks fixes under every other policy in the background for the Jaccard column", async () => {
    const started = await request(app).post(`/audits/${id}/sensitivity/fixes`);
    expect(started.status).toBe(202);
    expect(started.body.job.status).toBe("running");
    for (;;) {
      const job = runner.policyJob(id);
      if (job !== null && job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(runner.policyJob(id)).toMatchObject({
      status: "completed",
      done: ["P0", "P1", "P2", "P3", "P4", "P5"],
    });
    const res = await request(app).get(`/audits/${id}/sensitivity?k=25`);
    expect(res.body.fixesJob.status).toBe("completed");
    for (const r of res.body.policies) {
      expect(r.fixesRanked).toBeGreaterThanOrEqual(0);
      expect(r.topFixesJaccard).toBeGreaterThanOrEqual(0);
      expect(r.topFixesJaccard).toBeLessThanOrEqual(1);
    }
    const { rows } = await pool.query<{ policy_version: string }>(
      "SELECT DISTINCT policy_version FROM artefacts WHERE run_id = $1 AND kind = 'fix-ranking' ORDER BY 1",
      [id],
    );
    expect(rows.map((r) => r.policy_version)).toEqual([
      "P0@1.0.0",
      "P1@1.0.0",
      "P2@1.0.0",
      "P3@1.0.0",
      "P4@1.0.0",
      "P5@1.0.0",
    ]);
  });

  it("serves the reconciliation: every URL's channels, orphans first, and each channel's yield", async () => {
    const res = await request(app).get(`/audits/${id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body.orphans).toBe(5);
    const first = res.body.inventory.slice(0, 5);
    for (const e of first) expect(e.orphan).toBe(true);
    const orphan = res.body.inventory.find((e: { node: string }) => e.node === `${o}/orphan.html`);
    expect(orphan.channels).toEqual(["xml_sitemap"]);
    expect(res.body.channels.llms_txt.exclusive).toBeGreaterThanOrEqual(1);
  });

  it("serves single export files and a printable, escaped HTML report", async () => {
    const csv = await request(app).get(`/audits/${id}/export/fixes.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["content-disposition"]).toBe(
      `attachment; filename="linklens-audit-${id}-fixes.csv"`,
    );
    expect(csv.text.split("\r\n")[0]).toMatch(/^rank,target_rank,type,/);
    const js = await request(app).get(`/audits/${id}/export/orphans.json`);
    expect(js.body.orphans).toHaveLength(5);
    expect((await request(app).get(`/audits/${id}/export/secrets.txt`)).status).toBe(400);

    const report = await request(app).get(`/audits/${id}/report`);
    expect(report.headers["content-type"]).toMatch(/text\/html/);
    for (const h of ["Issues", "Top ", "Diagnosis", "Orphans", "Pipeline"])
      expect(report.text).toContain(`<h2>${h}`);
    expect(report.text).toContain("window.print()");
    expect(report.text).not.toMatch(/<script/i);
  });

  it("exports a zip of JSON and CSV files", async () => {
    const res = await request(app)
      .get(`/audits/${id}/export`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="linklens-audit-${id}.zip"`,
    );
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    expect(Object.keys(files).sort()).toEqual(
      [
        "audit.json",
        "diagnosis.csv",
        "diagnosis.json",
        "explanations.json",
        "fixes.csv",
        "fixes.json",
        "issues.csv",
        "issues.json",
        "orphans.csv",
        "orphans.json",
        "summary.json",
      ].sort(),
    );
    const fixesCsv = strFromU8(files["fixes.csv"] as Uint8Array);
    expect(fixesCsv.split("\r\n")[0]).toBe(
      "rank,target_rank,type,donor,target,score,delta_pr,delta_depth,sigma_variant,sigma,ref,cosine,kappa,policy_version,explanation",
    );
    expect(JSON.parse(strFromU8(files["audit.json"] as Uint8Array))).toMatchObject({
      id,
      status: "completed",
    });
  });

  it("imports analytics and re-runs from prominence only", async () => {
    const before = (await request(app).get(`/audits/${id}`)).body.stages as {
      stage: string;
      startedAt: string;
    }[];
    const csv = `source_url,target_url,clicks\n${o}/,${o}/deep/1.html,90\n${o}/,${o}/about.html,10\n`;
    const res = await request(app)
      .post(`/audits/${id}/analytics?name=ga.csv`)
      .set("Content-Type", "text/csv")
      .send(csv);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id, imported: 2, rerunFrom: "prominence" });
    const after = (await waitFor(id, ["completed", "failed"])) as {
      status: string;
      stages: { stage: string; startedAt: string; detail: Record<string, unknown> }[];
    };
    expect(after.status).toBe("completed");
    const cut = STAGES.indexOf("prominence");
    after.stages.forEach((s, i) => {
      const was = before[i]?.startedAt;
      if (i < cut) expect(s.startedAt).toBe(was);
      else expect(s.startedAt).not.toBe(was);
    });
    expect(after.stages[cut]?.detail["analytics"]).toMatchObject({
      rows: 2,
      matchedRows: 2,
      overriddenSources: 1,
    });
  });

  it("rejects a bad CSV with every problem listed", async () => {
    const res = await request(app)
      .post(`/audits/${id}/analytics`)
      .set("Content-Type", "text/csv")
      .send("source_url,target_url,clicks\n/a,/b,-1\n/a,/b,x\n");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_csv");
    expect(res.body.error.details).toHaveLength(2);
  });

  it("closes the event stream at once for a finished audit", async () => {
    const e = await readEvents(`/audits/${id}/events`);
    expect(e.map((x) => x.event)).toEqual(["snapshot", "done"]);
  });
});

describe("resuming", () => {
  it("fails at a stage, then resumes from it without re-running the earlier stages", async () => {
    failNext = "ref";
    const res = await request(app)
      .post("/audits")
      .send({
        url: `${server.origin}/`,
        pageCap: 20,
        policy: "P3",
        options: { workers: 1, config: CONFIG },
      });
    const id = res.body.id as number;
    const failed = (await waitFor(id, ["failed"])) as {
      error: string;
      stages: { stage: string; status: string; startedAt: string }[];
    };
    expect(failed.error).toBe("injected failure at ref");
    const refAt = STAGES.indexOf("ref");
    failed.stages.forEach((s, i) =>
      expect(s.status).toBe(i < refAt ? "completed" : i === refAt ? "failed" : "pending"),
    );
    // Not there yet: 409.
    const early = await request(app).get(`/audits/${id}/fixes`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("not_ready");

    const resumed = await request(app).post(`/audits/${id}/resume`);
    expect(resumed.status).toBe(202);
    const done = (await waitFor(id, ["completed", "failed"])) as {
      status: string;
      stages: { stage: string; status: string; startedAt: string }[];
    };
    expect(done.status).toBe("completed");
    done.stages
      .slice(0, refAt)
      .forEach((s, i) => expect(s.startedAt).toBe(failed.stages[i]?.startedAt));
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM artefacts WHERE run_id = $1 AND kind = 'link-graph'",
      [id],
    );
    expect(rows[0].n).toBe(1); // the graph stage ran once
    expect((await request(app).post(`/audits/${id}/resume`)).status).toBe(409); // already completed
  });
});

describe("errors against a real database", () => {
  it("404s an unknown audit on every route", async () => {
    for (const path of [
      "",
      "/summary",
      "/graph",
      "/issues",
      "/diagnosis",
      "/fixes",
      "/orphans",
      "/sensitivity",
      "/export",
      "/events",
    ]) {
      const res = await request(app).get(`/audits/999999${path}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
  });

  it("refuses an audit whose User-Agent has no contact URL (the default config)", async () => {
    const res = await request(app)
      .post("/audits")
      .send({ url: `${server.origin}/` });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_audit");
    expect(res.body.error.message).toMatch(/userAgent/);
  });
});
