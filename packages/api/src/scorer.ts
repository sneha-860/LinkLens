import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixes } from "@linklens/core";

export type ModelKind = "ranker" | "graphsage";

/**
 * Scores fixes with a trained model (the pipeline's learnedScore and graphsageScore stages).
 * `available` says why a model cannot be used (the stage is then skipped, never failed); `score`
 * answers one request (packages/core/src/fixes/scorers.ts).
 */
export interface ModelScorer {
  available(kind: ModelKind): Promise<{ ok: true } | { ok: false; reason: string }>;
  score(request: fixes.RankerRequest, timeoutMs: number): Promise<fixes.RankerResponse>;
  score(request: fixes.GraphSageRequest, timeoutMs: number): Promise<fixes.GraphSageResponse>;
}

/**
 * The scorer could not run at all (no interpreter, a missing Python package or model file):
 * the stage is skipped with this reason. Any other failure is a real error.
 */
export class ScorerUnavailable extends Error {}

export interface PythonScorerOptions {
  /** The Python interpreter (with `pip install -e "analysis[ml]"`, and `[gnn]` for GraphSAGE). */
  readonly python: string;
  /** The `analysis/` directory (the `ml` package is imported from here). */
  readonly analysisDir: string;
  /** The deployable models: `<dir>/ranker/` (`python -m ml fit`), `<dir>/graphsage/` (`gnn-fit`). */
  readonly modelsDir: string;
}

/** stderr lines that mean the environment, not the request, is at fault. */
const UNAVAILABLE =
  /ModuleNotFoundError|No module named|FileNotFoundError: no (ranker|graphsage) model/;

/**
 * `python -m ml score` in a child process: one JSON request file in, one JSON response file out,
 * in a temporary directory removed afterwards. A CLI rather than a service: it runs once per
 * stage, so a process start (and, for GraphSAGE, importing torch) is small next to the audit,
 * and there is no port, supervisor or authentication to maintain.
 */
export class PythonScorer implements ModelScorer {
  constructor(private readonly options: PythonScorerOptions) {}

  get modelsDir(): string {
    return this.options.modelsDir;
  }

  async available(kind: ModelKind): Promise<{ ok: true } | { ok: false; reason: string }> {
    const model = join(this.options.modelsDir, kind, "model.json");
    if (!existsSync(model)) {
      const fit = kind === "ranker" ? "fit" : "gnn-fit";
      return { ok: false, reason: `no ${kind} model at ${model} (python -m ml ${fit})` };
    }
    if (!existsSync(join(this.options.analysisDir, "ml", "deploy.py"))) {
      return { ok: false, reason: `no analysis/ml package at ${this.options.analysisDir}` };
    }
    return { ok: true };
  }

  score(request: fixes.RankerRequest, timeoutMs: number): Promise<fixes.RankerResponse>;
  score(request: fixes.GraphSageRequest, timeoutMs: number): Promise<fixes.GraphSageResponse>;
  async score(
    request: fixes.ScorerRequest,
    timeoutMs: number,
  ): Promise<fixes.RankerResponse | fixes.GraphSageResponse> {
    const dir = await mkdtemp(join(tmpdir(), "linklens-scorer-"));
    try {
      const req = join(dir, "request.json");
      const res = join(dir, "response.json");
      await writeFile(req, JSON.stringify(request), "utf8");
      await this.run(
        ["-m", "ml", "score", req, "--models", this.options.modelsDir, "--out", res],
        timeoutMs,
      );
      const body: unknown = JSON.parse(await readFile(res, "utf8"));
      return request.kind === "ranker"
        ? fixes.checkResponse<fixes.RankerResponse>(body, "ranker")
        : fixes.checkResponse<fixes.GraphSageResponse>(body, "graphsage");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private run(args: string[], timeoutMs: number): Promise<void> {
    const { python, analysisDir } = this.options;
    return new Promise((resolve, reject) => {
      const child = spawn(python, args, {
        cwd: analysisDir,
        env: {
          ...process.env,
          PYTHONPATH: [analysisDir, process.env["PYTHONPATH"]]
            .filter(Boolean)
            .join(process.platform === "win32" ? ";" : ":"),
          PYTHONIOENCODING: "utf-8",
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString("utf8")).slice(-8000);
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          e.code === "ENOENT"
            ? new ScorerUnavailable(`no Python interpreter at ${python} (set LINKLENS_PYTHON)`)
            : e,
        );
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        if (signal !== null) {
          reject(new ScorerUnavailable(`the scorer was stopped after ${timeoutMs} ms (${signal})`));
        } else if (UNAVAILABLE.test(stderr)) {
          reject(new ScorerUnavailable(`the scorer cannot run: ${tail}`));
        } else {
          reject(new Error(`the scorer exited with code ${code}: ${tail}`));
        }
      });
    });
  }
}

/**
 * The scorer from the environment: LINKLENS_PYTHON (default: analysis/.venv's interpreter when
 * there is one, else `python`), LINKLENS_MODELS_DIR (default <cacheDir>/scoring-models).
 */
export function pythonScorerFromEnv(
  env: NodeJS.ProcessEnv,
  repo: string,
  cacheDir: string,
): PythonScorer {
  const analysisDir = join(repo, "analysis");
  const venv =
    process.platform === "win32"
      ? join(analysisDir, ".venv", "Scripts", "python.exe")
      : join(analysisDir, ".venv", "bin", "python");
  return new PythonScorer({
    python: env["LINKLENS_PYTHON"] ?? (existsSync(venv) ? venv : "python"),
    analysisDir,
    modelsDir: env["LINKLENS_MODELS_DIR"] ?? join(cacheDir, "scoring-models"),
  });
}
