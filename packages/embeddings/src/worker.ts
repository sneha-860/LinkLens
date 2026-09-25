import { parentPort, workerData } from "node:worker_threads";
import { EmbeddingEngine } from "./engine.js";
import type { EmbedMessage, WorkerInit, WorkerReply } from "./protocol.js";

// Runs in a worker thread: owns the model, so inference never blocks the API's event loop.
// Requests are handled one at a time, in order.
if (parentPort === null) throw new Error("worker.ts must run in a worker thread");
const port = parentPort;
const engine = new EmbeddingEngine((workerData as WorkerInit).options);

let queue: Promise<void> = Promise.resolve();
port.on("message", (msg: EmbedMessage) => {
  queue = queue.then(async () => {
    let reply: WorkerReply;
    try {
      reply = { id: msg.id, ok: true, result: await engine.embed(msg.requests) };
    } catch (e) {
      reply = { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // Hand the vectors' buffers over instead of copying them (each buffer once).
    const transfer = reply.ok ? [...new Set(reply.result.vectors.map((v) => v.buffer))] : [];
    port.postMessage(reply, transfer as ArrayBuffer[]);
  });
});
