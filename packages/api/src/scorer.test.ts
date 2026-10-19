import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixes } from "@linklens/core";
import { PythonScorer, ScorerUnavailable, pythonScorerFromEnv } from "./scorer.js";

let dir: string;
let analysisDir: string;
let modelsDir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "linklens-scorer-test-"));
  analysisDir = join(dir, "analysis");
  modelsDir = join(dir, "models");
  await mkdir(join(analysisDir, "ml"), { recursive: true });
  await writeFile(join(analysisDir, "ml", "deploy.py"), "");
  await mkdir(join(modelsDir, "ranker"), { recursive: true });
  await writeFile(join(modelsDir, "ranker", "model.json"), "{}");
});

afterAll(() => rm(dir, { recursive: true, force: true }));

const request = fixes.rankerRequest([], fixes.FEATURES, 3);

describe("PythonScorer", () => {
  it("is available only with the model's files and the ml package", async () => {
    const s = new PythonScorer({ python: "python", analysisDir, modelsDir });
    expect(await s.available("ranker")).toEqual({ ok: true });
    const missing = await s.available("graphsage");
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { reason: string }).reason).toMatch(/no graphsage model .*gnn-fit/);
    const noPackage = new PythonScorer({ python: "python", analysisDir: dir, modelsDir });
    expect(await noPackage.available("ranker")).toMatchObject({ ok: false });
  });

  it("treats a missing interpreter as unavailable (the stage skips)", async () => {
    const s = new PythonScorer({
      python: join(dir, "no-such-python"),
      analysisDir,
      modelsDir,
    });
    await expect(s.score(request, 5_000)).rejects.toBeInstanceOf(ScorerUnavailable);
  });

  it("reports a scorer that ran and failed as an error, not as unavailable", async () => {
    // Node rejects `-m ml score …` with a non-zero exit and no Python import error.
    const s = new PythonScorer({ python: process.execPath, analysisDir, modelsDir });
    const e = await s.score(request, 10_000).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ScorerUnavailable);
    expect((e as Error).message).toMatch(/exited with code/);
  });

  it("reads the interpreter and models directory from the environment", () => {
    const s = pythonScorerFromEnv(
      { LINKLENS_PYTHON: "/opt/py", LINKLENS_MODELS_DIR: "/m" },
      dir,
      "/cache",
    );
    expect(s.modelsDir).toBe("/m");
    expect(pythonScorerFromEnv({}, dir, "/cache").modelsDir).toBe(join("/cache", "scoring-models"));
  });
});
