import { parentPort, workerData } from "node:worker_threads";
import { fixes } from "@linklens/core";
import type { ChunkMessage, ChunkReply, TimedResult, WorkerInit } from "./protocol.js";

// Runs in a worker thread: simulates chunks of scenarios against a shared baseline.
if (parentPort === null) throw new Error("worker.ts must run in a worker thread");
const port = parentPort;
const { graph, baseline, bodyWeight, params } = workerData as WorkerInit;
// One set of buffers for every scenario this worker runs: no per-candidate allocation.
const ws = fixes.workspace(graph);

port.on("message", (msg: ChunkMessage) => {
  let reply: ChunkReply;
  try {
    const results: TimedResult[] = msg.scenarios.map((s) => {
      const started = performance.now();
      const r = fixes.simulate(graph, baseline, s, bodyWeight, params, true, ws);
      return { ...r, runtimeMs: performance.now() - started };
    });
    reply = { chunk: msg.chunk, ok: true, results };
  } catch (e) {
    reply = { chunk: msg.chunk, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  port.postMessage(reply);
});
