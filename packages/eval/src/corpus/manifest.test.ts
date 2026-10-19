import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeConfig } from "@linklens/core";
import { parseCorpus, resolveConfig } from "./corpus.js";
import {
  MANIFEST_FILE,
  configSha256,
  currentVersions,
  markCrashedSessions,
  modelInfo,
  newManifest,
  readManifest,
  resumeProblems,
  scoringModelInfo,
  scoringModelsInfo,
  stableJson,
  writeJsonAtomic,
  type GitState,
} from "./manifest.js";

const TEXT = `
version: 1
seed: 42
policy: P3
sigma: refGateCosine
refVariant: weighted
config: { pageCap: 20 }
classes:
  blog: { label: Blog }
sites:
  - { id: a, url: "https://a.test/", architecture_class: blog }
  - { id: b, url: "https://b.test/", architecture_class: blog }
`;
const corpus = parseCorpus(TEXT);
const config = resolveConfig(corpus);
const clean: GitState = {
  commit: "abc",
  branch: "main",
  dirty: false,
  changes: [],
  diffSha256: null,
};

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "linklens-manifest-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const manifest = () =>
  newManifest({
    batchId: "b1",
    corpus,
    corpusFile: "packages/eval/corpus.yaml",
    config,
    git: clean,
    model: modelInfo(config, tmp()),
    lockfileSha256: null,
    now: "2026-01-01T00:00:00.000Z",
  });

describe("newManifest", () => {
  it("records config, seed, User-Agent, versions and one pending entry per site", () => {
    const m = manifest();
    expect(m).toMatchObject({
      batchId: "b1",
      seed: 42,
      userAgent: config.userAgent,
      audit: {
        policy: "P3",
        sigma: "refGateCosine",
        refVariant: "weighted",
        rankAllPolicies: true,
      },
      corpus: { sites: 2, sha256: corpus.sha256, classes: [{ id: "blog", sites: 2 }] },
      finishedAt: null,
    });
    expect(m.config.pageCap).toBe(20);
    expect(m.configSha256).toBe(configSha256(config));
    expect(m.versions.policies.P5).toMatch(/^P5@/);
    expect(m.versions.text).toMatch(/^text@/);
    expect(m.sites.map((s) => [s.id, s.status, s.runId])).toEqual([
      ["a", "pending", null],
      ["b", "pending", null],
    ]);
  });
});

describe("resumeProblems", () => {
  const check = { corpus, config, git: clean };

  it("allows the same batch, with new notes", () => {
    const withNotes = parseCorpus(
      TEXT.replace("blog }\n  - { id: b", "blog, notes: x }\n  - { id: b"),
    );
    expect(resumeProblems(manifest(), { ...check, corpus: withNotes })).toEqual([]);
  });

  it("refuses a changed config, audit, site list or version", () => {
    const m = manifest();
    expect(
      resumeProblems(m, { ...check, config: makeConfig({ ...config, pageCap: 21 }) })[0],
    ).toMatch(/config differs.*pageCap/);
    const sigma = parseCorpus(TEXT.replace("refGateCosine", "cosineOnly"));
    expect(resumeProblems(m, { ...check, corpus: sigma })[0]).toMatch(/audit settings/);
    const oneRanking = parseCorpus(
      TEXT.replace("refVariant: weighted", "refVariant: weighted\nrankAllPolicies: false"),
    );
    expect(resumeProblems(m, { ...check, corpus: oneRanking })[0]).toMatch(/rankAllPolicies/);
    const moreSites = parseCorpus(
      `${TEXT}  - { id: c, url: "https://c.test/", architecture_class: blog }\n`,
    );
    expect(resumeProblems(m, { ...check, corpus: moreSites })[0]).toMatch(/added: c https/);
    const old = { ...m, versions: { ...m.versions, ref: "ref@0.9.0" } };
    expect(resumeProblems(old, check)[0]).toMatch(/stage versions changed/);
  });

  it("lets a setting added since the batch was created keep its default, not change it", () => {
    const m = manifest();
    const older = { ...m.config } as Record<string, unknown>;
    delete older["throttleStateTtlMs"];
    const batch = { ...m, config: older as unknown as typeof m.config, configSha256: "older" };
    expect(resumeProblems(batch, check)).toEqual([]);
    const changed = makeConfig({ ...config, throttleStateTtlMs: 5 });
    expect(resumeProblems(batch, { ...check, config: changed })[0]).toMatch(
      /config differs.*\(throttleStateTtlMs\)/,
    );
  });

  it("refuses a different embedding model, once both are known", () => {
    const m = manifest();
    m.model = { ...m.model, sha256: "aaa" };
    expect(resumeProblems(m, { ...check, model: { sha256: "bbb" } })[0]).toMatch(/embedding model/);
    expect(resumeProblems(m, { ...check, model: { sha256: "aaa" } })).toEqual([]);
    expect(resumeProblems(m, { ...check, model: { sha256: null } })).toEqual([]);
  });

  it("refuses a code change unless allowed", () => {
    const m = manifest();
    const moved = { ...clean, commit: "def" };
    expect(resumeProblems(m, { ...check, git: moved })[0]).toMatch(/--allow-code-change/);
    const dirty = { ...clean, dirty: true, diffSha256: "d1" };
    expect(resumeProblems(m, { ...check, git: dirty })).toHaveLength(1);
    expect(resumeProblems(m, { ...check, git: moved, allowCodeChange: true })).toEqual([]);
  });
});

describe("stableJson", () => {
  it("sorts object keys at every level, not arrays", () => {
    expect(stableJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
    expect(configSha256(makeConfig({}))).toBe(configSha256(makeConfig({})));
  });
});

describe("modelInfo", () => {
  it("hashes every file of the model directory, sorted by path", () => {
    const dir = tmp();
    const model = join(dir, "Xenova", "all-MiniLM-L6-v2");
    mkdirSync(join(model, "onnx"), { recursive: true });
    writeFileSync(join(model, "tokenizer.json"), "{}");
    writeFileSync(join(model, "onnx", "model.onnx"), "weights");
    const a = modelInfo(config, dir);
    expect(a.files.map((f) => [f.path, f.bytes])).toEqual([
      ["onnx/model.onnx", 7],
      ["tokenizer.json", 2],
    ]);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(modelInfo(config, dir).sha256).toBe(a.sha256);
    writeFileSync(join(model, "onnx", "model.onnx"), "weights2");
    expect(modelInfo(config, dir).sha256).not.toBe(a.sha256);
  });

  it("is null before the model is downloaded", () => {
    const m = modelInfo(config, tmp());
    expect(m).toMatchObject({
      name: "Xenova/all-MiniLM-L6-v2",
      dtype: "fp32",
      files: [],
      sha256: null,
    });
  });
});

describe("scoringModelInfo", () => {
  it("hashes a deployable model as the Python scorer does, with what it was fit on", () => {
    const dir = tmp();
    const ranker = join(dir, "ranker");
    mkdirSync(ranker, { recursive: true });
    const meta = JSON.stringify({ trainedOn: ["a", "b"], dataset: "d1", createdAt: "t" });
    writeFileSync(join(ranker, "model.txt"), "trees");
    writeFileSync(join(ranker, "model.json"), meta);
    const info = scoringModelInfo(dir, "ranker");
    const sha = (x: string) => createHash("sha256").update(x).digest("hex");
    // analysis/ml/deploy.py model_sha256: "name\0sha256\n" per file, sorted by name.
    expect(info.sha256).toBe(sha(`model.json\0${sha(meta)}\nmodel.txt\0${sha("trees")}\n`));
    expect(info).toMatchObject({
      kind: "ranker",
      trainedOn: ["a", "b"],
      dataset: "d1",
      artefactVersion: "learned@1.1.0",
    });
    expect(scoringModelsInfo(dir).graphsage).toMatchObject({ sha256: null, files: [] });
  });

  it("refuses to resume with a different scoring model, once both are known", () => {
    const m = manifest();
    const models = (ranker: string | null) => ({
      ranker: { sha256: ranker },
      graphsage: { sha256: null },
    });
    m.scoringModels = {
      ranker: { ...scoringModelInfo(tmp(), "ranker"), sha256: "r1" },
      graphsage: scoringModelInfo(tmp(), "graphsage"),
    };
    const check = { corpus, config, git: clean };
    expect(resumeProblems(m, { ...check, scoringModels: models("r2") })[0]).toMatch(
      /ranker scoring model differs/,
    );
    expect(resumeProblems(m, { ...check, scoringModels: models("r1") })).toEqual([]);
    expect(resumeProblems(m, { ...check, scoringModels: models(null) })).toEqual([]);
  });
});

describe("writeJsonAtomic / readManifest", () => {
  it("round-trips and leaves no temporary file", () => {
    const dir = tmp();
    expect(readManifest(dir)).toBeNull();
    const m = manifest();
    writeJsonAtomic(join(dir, MANIFEST_FILE), m);
    expect(readManifest(dir)).toEqual(JSON.parse(JSON.stringify(m)));
    expect(readdirSync(dir)).toEqual([MANIFEST_FILE]);
    expect(readFileSync(join(dir, MANIFEST_FILE), "utf8").endsWith("}\n")).toBe(true);
  });
});

describe("markCrashedSessions", () => {
  it("marks sessions a dead process left running", () => {
    const m = manifest();
    const session = (outcome: "running" | "finished") => ({
      startedAt: "t",
      finishedAt: null,
      git: clean,
      host: {} as never,
      outcome,
    });
    m.sessions.push(session("finished"), session("running"));
    expect(markCrashedSessions(m)).toBe(1);
    expect(m.sessions.map((s) => s.outcome)).toEqual(["finished", "crashed"]);
    expect(markCrashedSessions(m)).toBe(0);
  });
});

describe("currentVersions", () => {
  it("names every canonicalisation policy", () => {
    expect(Object.keys(currentVersions().policies)).toEqual(["P0", "P1", "P2", "P3", "P4", "P5"]);
  });
});
