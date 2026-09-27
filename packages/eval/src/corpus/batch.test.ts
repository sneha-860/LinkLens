import { describe, expect, it } from "vitest";
import { makeConfig } from "@linklens/core";
import { runBatch, type AuditDriver, type AuditRequest, type BatchHooks } from "./batch.js";
import { parseCorpus } from "./corpus.js";
import { modelInfo, newManifest, type Manifest } from "./manifest.js";

const corpus = parseCorpus(`
version: 1
seed: 42
policy: P3
sigma: refGateCosine
refVariant: weighted
classes:
  blog: { label: Blog }
sites:
  - { id: a, url: "https://a.test/", architecture_class: blog }
  - { id: b, url: "https://b.test/", architecture_class: blog }
  - { id: c, url: "https://c.test/", architecture_class: blog }
`);
const config = makeConfig({ randomSeed: 42 });
const audit: AuditRequest = {
  policy: "P3",
  sigma: "refGateCosine",
  refVariant: "weighted",
  rankAllPolicies: true,
  config,
};

const fresh = (): Manifest =>
  newManifest({
    batchId: "t",
    corpus,
    corpusFile: "corpus.yaml",
    config,
    git: { commit: "abc", branch: "main", dirty: false, changes: [], diffSha256: null },
    model: modelInfo(config, "/nonexistent-model-dir"),
    lockfileSha256: null,
    now: "t0",
  });

/** A driver whose audits finish (or fail) at once; `outcome` decides per URL. */
function fakeDriver(
  outcome: (url: string, runId: number) => "completed" | "failed" | "stop" = () => "completed",
) {
  let next = 100;
  const urls = new Map<number, string>();
  const calls: string[] = [];
  let stop = false;
  const driver: AuditDriver = {
    create: (site, a) => {
      expect(a).toBe(audit);
      const id = next++;
      urls.set(id, site.url);
      calls.push(`create ${site.url}`);
      return Promise.resolve(id);
    },
    complete: (runId, a) => {
      expect(a).toBe(audit);
      calls.push(`complete ${runId}`);
      const o = outcome(urls.get(runId) ?? "", runId);
      if (o === "stop") {
        stop = true;
        return Promise.resolve({ status: "failed", error: "interrupted" });
      }
      return Promise.resolve({ status: o, error: o === "failed" ? "boom" : null });
    },
  };
  return { driver, calls, stopped: () => stop };
}

function hooks(stopped: () => boolean = () => false) {
  const saved: Manifest[] = [];
  let t = 0;
  const h: BatchHooks = {
    save: (m) => saved.push(structuredClone(m)),
    stamp: () => ({ commit: "abc", modelSha256: "m1" }),
    log: () => undefined,
    now: () => `t${++t}`,
    stopped,
  };
  return { h, saved };
}

describe("runBatch", () => {
  it("audits every site in corpus order and marks the batch finished", async () => {
    const m = fresh();
    const { driver, calls } = fakeDriver();
    const { h } = hooks();
    const s = await runBatch(m, audit, driver, h);
    expect(s).toEqual({ completed: 3, failed: 0, pending: 0, stopped: false });
    expect(calls).toEqual([
      "create https://a.test/",
      "complete 100",
      "create https://b.test/",
      "complete 101",
      "create https://c.test/",
      "complete 102",
    ]);
    expect(m.sites.map((x) => [x.status, x.runId, x.attempts, x.commit, x.modelSha256])).toEqual([
      ["completed", 100, 1, "abc", "m1"],
      ["completed", 101, 1, "abc", "m1"],
      ["completed", 102, 1, "abc", "m1"],
    ]);
    expect(m.finishedAt).not.toBeNull();

    // Running a finished batch again does nothing and keeps its finish time.
    const finished = m.finishedAt;
    const again = fakeDriver();
    await runBatch(m, audit, again.driver, hooks().h);
    expect(again.calls).toEqual([]);
    expect(m.finishedAt).toBe(finished);
  });

  it("saves the run id before waiting for the audit", async () => {
    const m = fresh();
    const { driver } = fakeDriver();
    const { h, saved } = hooks();
    await runBatch(m, audit, driver, h, { only: ["a"] });
    const beforeDone = saved.find((x) => x.sites[0]?.runId === 100);
    expect(beforeDone?.sites[0]?.status).toBe("running");
    expect(m.finishedAt).toBeNull(); // b and c still pending
  });

  it("resumes an interrupted site with the same run, then continues", async () => {
    const m = fresh();
    const first = fakeDriver((url) => (url === "https://b.test/" ? "stop" : "completed"));
    const s1 = await runBatch(m, audit, first.driver, hooks(first.stopped).h);
    expect(s1).toEqual({ completed: 1, failed: 0, pending: 2, stopped: true });
    expect(m.sites.map((x) => [x.status, x.runId])).toEqual([
      ["completed", 100],
      ["running", 101],
      ["pending", null],
    ]);

    const second = fakeDriver();
    const s2 = await runBatch(m, audit, second.driver, hooks().h);
    expect(s2.completed).toBe(3);
    // a is skipped, b resumes run 101 (no new run), c is created.
    expect(second.calls).toEqual(["complete 101", "create https://c.test/", "complete 100"]);
    expect(m.sites[1]).toMatchObject({ status: "completed", runId: 101, attempts: 2 });
  });

  it("leaves failed sites alone unless asked to retry them", async () => {
    const m = fresh();
    const d = fakeDriver((url) => (url === "https://a.test/" ? "failed" : "completed"));
    const s = await runBatch(m, audit, d.driver, hooks().h);
    expect(s).toMatchObject({ completed: 2, failed: 1 });
    expect(m.sites[0]).toMatchObject({ status: "failed", error: "boom", runId: 100 });
    expect(m.finishedAt).not.toBeNull();

    const again = fakeDriver();
    await runBatch(m, audit, again.driver, hooks().h);
    expect(again.calls).toEqual([]);
    await runBatch(m, audit, again.driver, hooks().h, { retryFailed: true });
    expect(again.calls).toEqual(["complete 100"]); // the same run, from its failed stage
    expect(m.sites[0]).toMatchObject({ status: "completed", error: null, attempts: 2 });
  });

  it("records a driver error as a failed site and goes on", async () => {
    const m = fresh();
    const { driver } = fakeDriver();
    const failing: AuditDriver = {
      ...driver,
      create: (site, a) =>
        site.url === "https://a.test/"
          ? Promise.reject(new Error("no User-Agent"))
          : driver.create(site, a),
    };
    const s = await runBatch(m, audit, failing, hooks().h);
    expect(s).toMatchObject({ completed: 2, failed: 1 });
    expect(m.sites[0]).toMatchObject({ status: "failed", runId: null, error: "no User-Agent" });
  });

  it("refuses unknown site ids", async () => {
    await expect(
      runBatch(fresh(), audit, fakeDriver().driver, hooks().h, { only: ["zz"] }),
    ).rejects.toThrow(/unknown site id/);
  });
});
