import { readFileSync, writeFileSync } from "node:fs";
import { createPool, asQueryable, resolveDatabaseUrl } from "@linklens/db";
import type { canonicalise } from "@linklens/core";
import { experiments } from "./experiments.js";
import { runExperiment, type ExperimentId, type ExperimentOptions } from "./run.js";

const USAGE = `Usage: pnpm --filter @linklens/eval e <E1…E8> --run <id> [options]
  --policy P0…P5     policy (default P3)
  --run-b <id>       E4: the later crawl of the same site
  --sf <file>        E5: Screaming Frog internal_all.csv
  --ratings <file>   E8: filled rating sheet(s) (without: writes the sheet to fill)
  --sample <n>       E6/E7: links to hide (default 20)
  --seed <n>         seed (default 42)
  --k <n>            top k (default 10)
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
    ...(file("sf") === undefined ? {} : { screamingFrogCsv: file("sf") as string }),
    ...(file("ratings") === undefined ? {} : { ratingsCsv: file("ratings") as string }),
    ...(num("sample") === undefined ? {} : { sample: num("sample") as number }),
    ...(num("seed") === undefined ? {} : { seed: num("seed") as number }),
    ...(num("k") === undefined ? {} : { k: num("k") as number }),
  };
  const pool = createPool(resolveDatabaseUrl(process.env));
  try {
    const run = await runExperiment(asQueryable(pool), id as ExperimentId, options);
    const json = JSON.stringify(
      { experiment: run.id, artefactId: run.artefact.id, result: run.result },
      null,
      2,
    );
    console.log(json);
    if (opts.has("out")) writeFileSync(opts.get("out") as string, `${json}\n`);
  } finally {
    await pool.end();
  }
}

void main();
