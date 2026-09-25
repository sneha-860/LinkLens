import { Worker } from "node:worker_threads";
import type { EmbedRequest, EmbedResult, Embedder, EmbeddingOptions } from "./options.js";
import type { EmbedMessage, WorkerInit, WorkerReply } from "./protocol.js";

/**
 * Runs the embedding engine in a worker thread, so model loading and inference never block the
 * caller's event loop (the API stays responsive). Requests are answered in order. The model is
 * loaded in the worker on its first cache miss.
 */
export class EmbeddingWorker implements Embedder {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: EmbedResult) => void; reject: (e: Error) => void }
  >();
  private failure: Error | null = null;

  private constructor(
    readonly options: EmbeddingOptions,
    private readonly worker: Worker,
  ) {
    worker.on("message", (reply: WorkerReply) => {
      const p = this.pending.get(reply.id);
      if (p === undefined) return;
      this.pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.result);
      else p.reject(new Error(reply.error));
    });
    worker.on("error", (e) => this.fail(e));
    worker.on("exit", (code) => this.fail(new Error(`embedding worker exited (code ${code})`)));
  }

  static start(options: EmbeddingOptions): EmbeddingWorker {
    const fromSource = import.meta.url.endsWith(".ts");
    const entry = new URL(fromSource ? "./worker.ts" : "./worker.js", import.meta.url);
    const init: WorkerInit = fromSource ? { options, entry: entry.href } : { options };
    const worker = new Worker(
      fromSource ? new URL("./worker-bootstrap.mjs", import.meta.url) : entry,
      { workerData: init },
    );
    return new EmbeddingWorker(options, worker);
  }

  private fail(e: Error): void {
    this.failure ??= e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  embed(requests: readonly EmbedRequest[]): Promise<EmbedResult> {
    if (this.failure !== null) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg: EmbedMessage = { id, type: "embed", requests };
      this.worker.postMessage(msg);
    });
  }

  /** Stop the worker; pending requests are rejected. */
  async close(): Promise<void> {
    this.fail(new Error("embedding worker closed"));
    await this.worker.terminate();
  }
}
