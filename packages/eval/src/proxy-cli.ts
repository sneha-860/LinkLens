import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalise, db as q, prominence } from "@linklens/core";
import { asQueryable, createPool, resolveDatabaseUrl } from "@linklens/db";
import {
  PROXY_VERSION,
  linkLevel,
  loadProxyInputs,
  pageLevel,
  pageTable,
  parseSearchConsoleCsv,
  proxyMarkdown,
  proxyParams,
  sourceLinks,
  type ProxyReport,
} from "./proxy-validation.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const USAGE = `Usage: pnpm --filter @linklens/eval proxy --run <id> [--policy P3] <click data> [--out <file.json>]
Click data (one or both):
  --analytics <file.csv>   link level: source_url, target_url, clicks (e.g. a GA4 path export)
  --stored                 link level: the analytics rows already imported for the run
  --gsc <file.csv>         page level: a Search Console "Pages" export (page, clicks)
  --zero-fill              page level: crawled pages missing from the export count as 0 clicks
Needs DATABASE_URL (the repository's .env is read).`;

const dotenv = join(REPO, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

function parseArgs(argv: string[]): { flags: Set<string>; opts: Map<string, string> } {
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.add(a.slice(2));
    else {
      opts.set(a.slice(2), next);
      i++;
    }
  }
  return { flags, opts };
}

async function main(): Promise<void> {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  const runId = Number(opts.get("run"));
  const policy = (opts.get("policy") ?? "P3") as canonicalise.PolicyId;
  const analytics = opts.get("analytics");
  const gsc = opts.get("gsc");
  if (!Number.isInteger(runId) || runId <= 0 || !(policy in canonicalise.POLICIES)) {
    throw new Error(USAGE);
  }
  if (analytics === undefined && gsc === undefined && !flags.has("stored")) throw new Error(USAGE);

  const pool = createPool(resolveDatabaseUrl(process.env));
  try {
    const db = asQueryable(pool);
    const inputs = await loadProxyInputs(db, runId, policy);
    const sources: string[] = [];
    let link: ProxyReport["linkLevel"];
    let page: ProxyReport["pageLevel"];

    if (analytics !== undefined || flags.has("stored")) {
      const rows =
        analytics !== undefined
          ? prominence.parseAnalyticsCsv(readFileSync(resolve(analytics), "utf8"))
          : await q.listAnalyticsClicks(db, runId);
      sources.push(analytics !== undefined ? basename(analytics) : "stored analytics");
      const mapped = prominence.mapClicks(rows, inputs.isInternal, inputs.canonicalise);
      link = linkLevel(sourceLinks(inputs.edges, mapped), inputs.config);
    }
    if (gsc !== undefined) {
      sources.push(basename(gsc));
      const zeroFill = flags.has("zero-fill");
      const table = pageTable(
        {
          pages: inputs.pages,
          seed: inputs.seed,
          edges: inputs.edges,
          rows: parseSearchConsoleCsv(readFileSync(resolve(gsc), "utf8")),
          isInternal: inputs.isInternal,
          canonicalise: inputs.canonicalise,
          zeroFill,
        },
        inputs.config,
      );
      page = pageLevel(table, zeroFill, inputs.config);
    }

    const report: ProxyReport = {
      version: PROXY_VERSION,
      runId,
      policyVersion: inputs.policyVersion,
      source: sources.join(" + "),
      params: proxyParams(inputs.config),
      ...(link === undefined ? {} : { linkLevel: link }),
      ...(page === undefined ? {} : { pageLevel: page }),
    };
    console.log(proxyMarkdown(report));
    const out = opts.get("out");
    if (out !== undefined) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.error(`written to ${resolve(out)}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
