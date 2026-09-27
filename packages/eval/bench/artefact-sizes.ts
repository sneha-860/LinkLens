// Artefact sizes at scale: a synthetic site of --pages pages (default 500) is stored as a crawl in
// a throwaway database, run through the pipeline's database stages, and measured.
//   pnpm --filter @linklens/eval sizes [--pages 500] [--seed 42] [--out file.md]
// Needs the docker-compose Postgres (pnpm services:up). The database is dropped afterwards.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeConfig } from "@linklens/core";
import { asQueryable, createPool } from "@linklens/db";
import { createMigratedTempDatabase, dropTempDatabase } from "@linklens/db/testing";
import {
  artefactSizes,
  hashingEmbedder,
  rawSizes,
  runStoredPipeline,
  seedSyntheticRun,
  sizesMarkdown,
  syntheticSite,
} from "../src/index.js";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const pages = Number(arg("pages") ?? 500);
const seed = Number(arg("seed") ?? 42);

const url = await createMigratedTempDatabase();
const pool = createPool(url);
try {
  const db = asQueryable(pool);
  const config = makeConfig({ pageCap: 500 });
  const site = syntheticSite({ pages, seed });
  const runId = await seedSyntheticRun(db, "https://synthetic.test", site, config);
  const timings = await runStoredPipeline(
    db,
    runId,
    "P3",
    hashingEmbedder({
      model: config.embeddingModel,
      dtype: config.embeddingDtype,
      bodyTokens: config.embeddingBodyTokens,
      batchSize: config.embeddingBatchSize,
      cacheDir: tmpdir(),
    }),
  );
  const report = sizesMarkdown(
    pages,
    await artefactSizes(db, runId),
    await rawSizes(db, runId),
    timings,
  );
  console.log(report);
  const out = arg("out");
  if (out !== undefined) writeFileSync(out, report);
} finally {
  await pool.end();
  await dropTempDatabase(url);
}
