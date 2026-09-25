import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { fixes } from "@linklens/core";
import type { ChunkMessage, ChunkReply, TimedResult, WorkerInit } from "./protocol.js";

/**
 * Workers for a setting of config.counterfactualWorkers. 0 = half the logical processors (about
 * the physical cores; at least 1): the simulation is CPU-bound, so hyperthread siblings and
 * efficiency cores add contention more than throughput.
 */
export function resolveWorkers(setting: number): number {
  return setting > 0 ? setting : Math.max(1, Math.floor(availableParallelism() / 2));
}

export interface PoolRun {
  /** One result per scenario, in scenario order. */
  readonly results: TimedResult[];
  readonly workers: number;
  readonly chunks: number;
  /** Wall-clock time for all scenarios, including starting the workers. */
  readonly wallMs: number;
}

/**
 * Simulate every scenario in worker threads. Scenarios are split into small chunks handed out
 * on demand (so a slow chunk does not hold up the rest); results are put back in scenario order,
 * so the output does not depend on the number of workers or on timing.
 */
export async function simulateInWorkers(
  init: Omit<WorkerInit, "entry">,
  scenarios: readonly fixes.Scenario[],
  workerSetting: number,
): Promise<PoolRun> {
  const started = performance.now();
  if (scenarios.length === 0) return { results: [], workers: 0, chunks: 0, wallMs: 0 };
  const wanted = resolveWorkers(workerSetting);
  // About four chunks per worker balances the load without much messaging.
  const size = Math.max(1, Math.ceil(scenarios.length / (wanted * 4)));
  const chunks: fixes.Scenario[][] = [];
  for (let i = 0; i < scenarios.length; i += size) chunks.push(scenarios.slice(i, i + size));
  const count = Math.min(wanted, chunks.length);

  const fromSource = import.meta.url.endsWith(".ts");
  const entry = new URL(fromSource ? "./worker.ts" : "./worker.js", import.meta.url);
  const data: WorkerInit = fromSource ? { ...init, entry: entry.href } : init;
  const workers = Array.from(
    { length: count },
    () =>
      new Worker(fromSource ? new URL("./worker-bootstrap.mjs", import.meta.url) : entry, {
        workerData: data,
      }),
  );

  const results: (TimedResult[] | undefined)[] = new Array(chunks.length);
  let next = 0;
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const send = () => {
              if (next >= chunks.length) return resolve();
              const chunk = next++;
              const msg: ChunkMessage = { chunk, scenarios: chunks[chunk] as fixes.Scenario[] };
              w.postMessage(msg);
            };
            w.on("message", (reply: ChunkReply) => {
              if (!reply.ok) return reject(new Error(`counterfactual worker: ${reply.error}`));
              results[reply.chunk] = reply.results;
              send();
            });
            w.on("error", reject);
            w.on("exit", (code) => {
              if (next < chunks.length || results.includes(undefined)) {
                reject(new Error(`counterfactual worker exited early (code ${code})`));
              }
            });
            send();
          }),
      ),
    );
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return {
    results: results.flatMap((r) => r as TimedResult[]),
    workers: count,
    chunks: chunks.length,
    wallMs: performance.now() - started,
  };
}
