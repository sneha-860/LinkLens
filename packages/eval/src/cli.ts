import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readExportDir } from "./e5-files.js";
import { fileURLToPath } from "node:url";
import { createPool, asQueryable, resolveDatabaseUrl } from "@linklens/db";
import { db as q, makeConfig, type canonicalise } from "@linklens/core";
import { EmbeddingWorker, embeddingOptions } from "@linklens/embeddings";
import { experiments } from "./experiments.js";
import { runExperiment, type ExperimentId, type ExperimentOptions } from "./run.js";

const USAGE = `Usage: pnpm --filter @linklens/eval e <E1…E8> --run <id> [options]
  --policy P0…P5     policy (default P3)
  --run-b <id>       E4: the later crawl of the same site
  --sf <file>        E5: Screaming Frog internal_all.csv (URLs, depth, its inlink column)
  --sf-dir <dir>     E5: a folder with internal_all.csv, all_inlinks.csv, orphan_pages.csv
  --ratings <file>   E8: filled rating sheet(s) (without: writes the sheet to fill)
  --sample <n>       E7: links to hide (default 20)
  --seed <n>         seed (default config.randomSeed; E6: repeat r uses seed + r)
  --k <n>            top k (default 10; E3: one k instead of config.e3TopKs)
  --out <file>       also write the JSON result here (for analysis/)
Needs DATABASE_URL (or the PG* variables).`;

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) out.set(a.slice(2), argv[i + 1] ?? "");
    if (a.startsWith("--")) i++;
  }
  return out;
}

async function main(): Promise<void> {
  const [id, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  if (id === undefined || !experiments.some((e) => e.id === id) || !opts.has("run")) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const num = (k: string) => (opts.has(k) ? Number(opts.get(k)) : undefined);
  const file = (k: string) =>
    opts.has(k) ? readFileSync(opts.get(k) as string, "utf8") : undefined;
  const options: ExperimentOptions = {
    runId: Number(opts.get("run")),
    policy: (opts.get("policy") ?? "P3") as canonicalise.PolicyId,
    ...(num("run-b") === undefined ? {} : { runB: num("run-b") as number }),
    ...(opts.has("sf-dir")
      ? { screamingFrog: readExportDir(opts.get("sf-dir") as string) }
      : file("sf") === undefined
        ? {}
        : { screamingFrog: { internal: file("sf") as string } }),
    ...(file("ratings") === undefined ? {} : { ratingsCsv: file("ratings") as string }),
    ...(num("sample") === undefined ? {} : { sample: num("sample") as number }),
    ...(num("seed") === undefined ? {} : { seed: num("seed") as number }),
    ...(num("k") === undefined ? {} : { k: num("k") as number }),
  };
  const pool = createPool(resolveDatabaseUrl(process.env));
  const db = asQueryable(pool);
  let embedder: EmbeddingWorker | undefined;
  try {
    if (id === "E3" || id === "E6") {
      // The run's model; cached embeddings are reused (E3 embeds the orphans' pages, E6 the
      // masked pages).
      const stored = await q.getRun(db, options.runId);
      if (stored === null) throw new Error(`run ${options.runId} not found`);
      const repo = fileURLToPath(new URL("../../../", import.meta.url));
      const cacheDir = resolve(repo, process.env["LINKLENS_CACHE_DIR"] ?? ".cache/linklens");
      embedder = EmbeddingWorker.start(embeddingOptions(makeConfig(stored.config), cacheDir));
    }
    const run = await runExperiment(db, id as ExperimentId, {
      ...options,
      ...(embedder === undefined ? {} : { embedder }),
    });
    const json = JSON.stringify(
      { experiment: run.id, artefactId: run.artefact.id, result: run.result },
      null,
      2,
    );
    console.log(json);
    if (opts.has("out")) writeFileSync(opts.get("out") as string, `${json}\n`);
  } finally {
    await embedder?.close();
    await pool.end();
  }
}

void main();
