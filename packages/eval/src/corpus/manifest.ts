import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, hostname, platform, release } from "node:os";
import { join, relative, sep } from "node:path";
import {
  canonicalise,
  defaultConfig,
  diagnosis,
  fixes,
  prominence,
  semantic,
  text,
  type LinkLensConfig,
} from "@linklens/core";
import { EMBEDDING_CACHE_VERSION } from "@linklens/embeddings";
import type { Corpus, CorpusSite } from "./corpus.js";

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = "manifest.json";

export type SiteStatus = "pending" | "running" | "completed" | "failed";

export interface GitState {
  /** HEAD commit, or null outside a git checkout. */
  readonly commit: string | null;
  readonly branch: string | null;
  /** Uncommitted changes to tracked files, or untracked files. */
  readonly dirty: boolean;
  /** `git status --porcelain` lines. */
  readonly changes: string[];
  /** SHA-256 of `git diff HEAD` (null when clean): identifies the uncommitted state. */
  readonly diffSha256: string | null;
}

export interface ModelFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ModelInfo {
  readonly name: string;
  readonly dtype: string;
  readonly bodyTokens: number;
  readonly embeddingCacheVersion: number;
  /** Where the model files were looked for. */
  readonly dir: string;
  /** Every file under the model's directory, sorted by path. */
  readonly files: ModelFile[];
  /** SHA-256 over "path\0sha256\n" of every file; null when the files are not there yet. */
  readonly sha256: string | null;
  readonly hashedAt: string;
}

/**
 * A deployable scoring model (`python -m ml fit` → ranker/, `gnn-fit` → graphsage/) as the
 * pipeline's learnedScore / graphsageScore stages use it. `sha256` is computed exactly as the
 * scorer reports it (analysis/ml/deploy.py model_sha256), so the manifest, the stage detail and
 * the artefact name the same model. Null until the model is fit.
 */
export interface ScoringModelInfo {
  readonly kind: "ranker" | "graphsage";
  readonly dir: string;
  readonly files: ModelFile[];
  readonly sha256: string | null;
  /** From its model.json: the corpus sites it was fit on, the dataset digest, when. */
  readonly trainedOn: string[];
  readonly dataset: string | null;
  readonly createdAt: string | null;
  /** The artefact version the stage writes with it. */
  readonly artefactVersion: string;
  readonly hashedAt: string;
}

export interface ScoringModels {
  readonly ranker: ScoringModelInfo;
  readonly graphsage: ScoringModelInfo;
}

export interface Versions {
  readonly policies: Record<canonicalise.PolicyId, string>;
  readonly text: string;
  readonly ref: string;
  readonly cosine: string;
  readonly prominence: string;
  readonly diagnosis: string;
  readonly candidates: string;
  readonly counterfactual: string;
  readonly scoring: string;
  readonly rescue: string;
  readonly explain: string;
  readonly embeddingCache: number;
}

export interface Host {
  readonly node: string;
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly cpus: number;
  readonly cpuModel: string | null;
  readonly hostname: string;
}

/** One invocation of `corpus run` (a batch resumed three times has four sessions). */
export interface Session {
  readonly startedAt: string;
  finishedAt: string | null;
  readonly git: GitState;
  readonly host: Host;
  /**
   * Why it stopped: every site done, interrupted (SIGINT/SIGTERM), an error, or crashed (still
   * "running" when the next session started: the process died without saving).
   */
  outcome: "running" | "finished" | "interrupted" | "error" | "crashed";
  error?: string;
}

/** Sessions left "running" by a process that died: mark them crashed. Returns how many. */
export function markCrashedSessions(m: Manifest): number {
  let n = 0;
  for (const s of m.sessions) {
    if (s.outcome === "running") {
      s.outcome = "crashed";
      n += 1;
    }
  }
  return n;
}

export interface SiteEntry {
  readonly id: string;
  readonly url: string;
  readonly architectureClass: string;
  status: SiteStatus;
  runId: number | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** The commit and model hash in force when the site finished. */
  commit: string | null;
  modelSha256: string | null;
  /** The scoring models' hashes in force when it finished (absent in older manifests). */
  scoringModels?: { ranker: string | null; graphsage: string | null };
}

export interface ExportRecord {
  readonly at: string;
  readonly git: GitState;
  readonly files: { readonly name: string; readonly rows: number; readonly sha256: string }[];
}

export interface Manifest {
  readonly manifestVersion: typeof MANIFEST_VERSION;
  readonly batchId: string;
  readonly createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  readonly corpus: {
    readonly file: string;
    readonly sha256: string;
    readonly sites: number;
    readonly classes: { readonly id: string; readonly label: string; readonly sites: number }[];
  };
  /** Git state when the batch was created (each session has its own). */
  readonly git: GitState;
  /** The full config every site ran with (defaults + corpus overrides + seed + User-Agent). */
  readonly config: Readonly<LinkLensConfig>;
  readonly configSha256: string;
  readonly seed: number;
  readonly userAgent: string;
  readonly audit: {
    readonly policy: canonicalise.PolicyId;
    readonly sigma: string;
    readonly refVariant: string;
    readonly rankAllPolicies: boolean;
  };
  readonly versions: Versions;
  model: ModelInfo;
  /** The deployable scoring models (absent in manifests written before they existed). */
  scoringModels?: ScoringModels;
  readonly lockfileSha256: string | null;
  /** A later wave of an earlier batch (E4's re-crawl): which batch, and how many days after. */
  readonly wave?: { readonly of: string; readonly afterDays: number };
  sessions: Session[];
  sites: SiteEntry[];
  exports: ExportRecord[];
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** JSON with object keys sorted, so equal values hash equally. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

export const configSha256 = (config: Readonly<LinkLensConfig>) => sha256(stableJson(config));

/** The version of every stage whose output the metrics depend on. */
export function currentVersions(): Versions {
  return {
    policies: Object.fromEntries(
      canonicalise.POLICY_IDS.map((p) => [p, canonicalise.POLICIES[p].version]),
    ) as Record<canonicalise.PolicyId, string>,
    text: text.TEXT_VERSION,
    ref: semantic.REF_VERSION,
    cosine: semantic.COSINE_VERSION,
    prominence: prominence.PROMINENCE_VERSION,
    diagnosis: diagnosis.DIAGNOSIS_VERSION,
    candidates: fixes.CANDIDATES_VERSION,
    counterfactual: fixes.COUNTERFACTUAL_VERSION,
    scoring: fixes.SCORING_VERSION,
    rescue: fixes.RESCUE_VERSION,
    explain: fixes.EXPLAIN_VERSION,
    embeddingCache: EMBEDDING_CACHE_VERSION,
  };
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * The repository's top-level folder of experiment output (corpus batches, LSH and L13 runs).
 * It is not code: a batch writing its own results there does not make the tree dirty.
 */
export const RESULTS_DIR = "results";

export function gitState(repo: string): GitState {
  const commit = git(repo, ["rev-parse", "HEAD"])?.trim() ?? null;
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? null;
  const code = ["--", ".", `:(exclude)${RESULTS_DIR}`];
  const changes = (git(repo, ["status", "--porcelain", ...code]) ?? "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const diff = changes.length === 0 ? null : git(repo, ["diff", "HEAD", "--binary", ...code]);
  return {
    commit,
    branch,
    dirty: changes.length > 0,
    changes,
    diffSha256: diff === null ? null : sha256(diff),
  };
}

export function hostInfo(): Host {
  const c = cpus();
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpus: c.length,
    cpuModel: c[0]?.model.trim() ?? null,
    hostname: hostname(),
  };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Hash the embedding model's files under `<modelDir>/<model name>` (transformers.js layout).
 * The model is downloaded on the first embedding cache miss, so before that there is nothing to
 * hash (sha256 null).
 */
export function modelInfo(config: Readonly<LinkLensConfig>, modelDir: string): ModelInfo {
  const dir = join(modelDir, ...config.embeddingModel.split("/"));
  const files: ModelFile[] =
    existsSync(dir) && statSync(dir).isDirectory()
      ? listFiles(dir)
          .map((p) => {
            const data = readFileSync(p);
            return {
              path: relative(dir, p).split(sep).join("/"),
              bytes: data.length,
              sha256: sha256(data),
            };
          })
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      : [];
  return {
    name: config.embeddingModel,
    dtype: config.embeddingDtype,
    bodyTokens: config.embeddingBodyTokens,
    embeddingCacheVersion: EMBEDDING_CACHE_VERSION,
    dir,
    files,
    sha256:
      files.length === 0 ? null : sha256(files.map((f) => `${f.path}\0${f.sha256}\n`).join("")),
    hashedAt: new Date().toISOString(),
  };
}

/** Hash a deployable scoring model directory (`<modelsDir>/<kind>/`), as the scorer does. */
export function scoringModelInfo(
  modelsDir: string,
  kind: "ranker" | "graphsage",
): ScoringModelInfo {
  const dir = join(modelsDir, kind);
  const files: ModelFile[] =
    existsSync(dir) && statSync(dir).isDirectory()
      ? listFiles(dir)
          .map((p) => {
            const data = readFileSync(p);
            return {
              path: relative(dir, p).split(sep).join("/"),
              bytes: data.length,
              sha256: sha256(data),
            };
          })
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      : [];
  const metaPath = join(dir, "model.json");
  const meta = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf8")) as {
        trainedOn?: string[];
        dataset?: string;
        createdAt?: string;
      })
    : null;
  return {
    kind,
    dir,
    files,
    sha256: meta === null ? null : sha256(files.map((f) => `${f.path}\0${f.sha256}\n`).join("")),
    trainedOn: meta?.trainedOn ?? [],
    dataset: meta?.dataset ?? null,
    createdAt: meta?.createdAt ?? null,
    artefactVersion: kind === "ranker" ? fixes.LEARNED_VERSION : fixes.GRAPHSAGE_VERSION,
    hashedAt: new Date().toISOString(),
  };
}

export const scoringModelsInfo = (modelsDir: string): ScoringModels => ({
  ranker: scoringModelInfo(modelsDir, "ranker"),
  graphsage: scoringModelInfo(modelsDir, "graphsage"),
});

export function fileSha256(path: string): string | null {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

export interface NewManifest {
  readonly batchId: string;
  readonly corpus: Corpus;
  readonly corpusFile: string;
  readonly config: Readonly<LinkLensConfig>;
  readonly git: GitState;
  readonly model: ModelInfo;
  readonly scoringModels?: ScoringModels;
  readonly lockfileSha256: string | null;
  readonly now: string;
  readonly wave?: { readonly of: string; readonly afterDays: number };
}

export function newManifest(m: NewManifest): Manifest {
  const { corpus } = m;
  return {
    manifestVersion: MANIFEST_VERSION,
    batchId: m.batchId,
    createdAt: m.now,
    updatedAt: m.now,
    finishedAt: null,
    corpus: {
      file: m.corpusFile,
      sha256: corpus.sha256,
      sites: corpus.sites.length,
      classes: corpus.classes.map((c) => ({
        id: c.id,
        label: c.label,
        sites: corpus.sites.filter((s) => s.architectureClass === c.id).length,
      })),
    },
    git: m.git,
    config: m.config,
    configSha256: configSha256(m.config),
    seed: m.config.randomSeed,
    userAgent: m.config.userAgent,
    audit: {
      policy: corpus.policy,
      sigma: corpus.sigma,
      refVariant: corpus.refVariant,
      rankAllPolicies: corpus.rankAllPolicies,
    },
    versions: currentVersions(),
    model: m.model,
    ...(m.scoringModels === undefined ? {} : { scoringModels: m.scoringModels }),
    lockfileSha256: m.lockfileSha256,
    sessions: [],
    sites: corpus.sites.map(pendingSite),
    exports: [],
    ...(m.wave === undefined ? {} : { wave: m.wave }),
  };
}

const pendingSite = (s: CorpusSite): SiteEntry => ({
  id: s.id,
  url: s.url,
  architectureClass: s.architectureClass,
  status: "pending",
  runId: null,
  attempts: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  commit: null,
  modelSha256: null,
});

export interface ResumeCheck {
  readonly corpus: Corpus;
  readonly config: Readonly<LinkLensConfig>;
  readonly git: GitState;
  /** Allow a different commit (or uncommitted changes) than the batch was created with. */
  readonly allowCodeChange?: boolean;
  /** The embedding model now (when known): its files must hash the same as the batch's. */
  readonly model?: Pick<ModelInfo, "sha256">;
  /** The scoring models now: each must hash the same as the batch's (once both exist). */
  readonly scoringModels?: {
    readonly ranker: Pick<ScoringModelInfo, "sha256">;
    readonly graphsage: Pick<ScoringModelInfo, "sha256">;
  };
}

/**
 * Why a batch cannot be resumed as it is (empty: it can). Resuming must not change anything
 * the results depend on: the config, the audit settings, the stage versions and the sites.
 * The notes and classes' descriptions may change.
 */
export function resumeProblems(m: Manifest, c: ResumeCheck): string[] {
  const problems: string[] = [];
  if (m.manifestVersion !== MANIFEST_VERSION) {
    problems.push(`manifest version ${m.manifestVersion} is not ${MANIFEST_VERSION}`);
  }
  if (configSha256(c.config) !== m.configSha256) {
    const now = c.config as unknown as Record<string, unknown>;
    const was = m.config as unknown as Record<string, unknown>;
    const defaults = defaultConfig as unknown as Record<string, unknown>;
    // A setting added after the batch was created is no change while it keeps its default:
    // new settings take the value the code used before they existed.
    const changed = [...new Set([...Object.keys(now), ...Object.keys(was)])].filter((k) =>
      k in was
        ? stableJson(now[k]) !== stableJson(was[k])
        : stableJson(now[k]) !== stableJson(defaults[k]),
    );
    if (changed.length > 0) {
      problems.push(`the config differs from the batch's (${changed.join(", ")})`);
    }
  }
  const audit = {
    policy: c.corpus.policy,
    sigma: c.corpus.sigma,
    refVariant: c.corpus.refVariant,
    rankAllPolicies: c.corpus.rankAllPolicies,
  };
  if (stableJson(audit) !== stableJson(m.audit)) {
    problems.push(`the audit settings differ: ${stableJson(audit)} vs ${stableJson(m.audit)}`);
  }
  const versions = currentVersions();
  if (stableJson(versions) !== stableJson(m.versions)) {
    problems.push(
      `stage versions changed since the batch was created: ${stableJson(m.versions)} → ${stableJson(versions)}`,
    );
  }
  const key = (s: { id: string; url: string; architectureClass: string }) =>
    `${s.id} ${s.url} ${s.architectureClass}`;
  const was = m.sites.map(key);
  const now = c.corpus.sites.map(key);
  if (stableJson(was) !== stableJson(now)) {
    const removed = was.filter((s) => !now.includes(s));
    const added = now.filter((s) => !was.includes(s));
    problems.push(
      `the site list changed (removed: ${removed.join("; ") || "none"}; added: ${added.join("; ") || "none"}; or reordered)`,
    );
  }
  const created = m.git;
  const codeChanged = c.git.commit !== created.commit || c.git.diffSha256 !== created.diffSha256;
  if (codeChanged && c.allowCodeChange !== true) {
    problems.push(
      `the code differs from the batch's (commit ${created.commit ?? "none"}` +
        `${created.dirty ? " + uncommitted changes" : ""} → ${c.git.commit ?? "none"}` +
        `${c.git.dirty ? " + uncommitted changes" : ""}); pass --allow-code-change to resume anyway`,
    );
  }
  if (
    c.model !== undefined &&
    c.model.sha256 !== null &&
    m.model.sha256 !== null &&
    c.model.sha256 !== m.model.sha256
  ) {
    problems.push(`the embedding model's files differ (${m.model.sha256} → ${c.model.sha256})`);
  }
  for (const kind of ["ranker", "graphsage"] as const) {
    const was = m.scoringModels?.[kind].sha256 ?? null;
    const now = c.scoringModels?.[kind].sha256 ?? null;
    if (was !== null && now !== null && was !== now) {
      problems.push(`the ${kind} scoring model differs (${was} → ${now})`);
    }
  }
  return problems;
}

/** Write JSON through a temporary file and a rename, so a crash never leaves half a file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readManifest(dir: string): Manifest | null {
  const path = join(dir, MANIFEST_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : null;
}
