import { Worker } from "node:worker_threads";
import type { db as q } from "@linklens/core";
import type { DbStage, StageCtx } from "./stages.js";

export interface StageWorkerData {
  readonly databaseUrl: string;
  /** Set when running from TypeScript sources: the module the bootstrap loads. */
  readonly entry?: string;
}
export interface StageRequest {
  readonly id: number;
  readonly stage: DbStage;
  readonly ctx: StageCtx;
}
export type StageReply =
  | { readonly id: number; readonly ok: true; readonly detail: q.Json }
  | { readonly id: number; readonly ok: false; readonly error: string };

interface Slot {
  readonly worker: Worker;
  busy: boolean;
  pending: { id: number; resolve: (d: q.Json) => void; reject: (e: Error) => void } | null;
}

/**
 * Up to `size` long-lived worker threads (started on demand) that run database-only stages.
 * A stage waits for a free worker; a worker that dies fails its stage and is replaced.
 */
export class StageWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly waiting: ((slot: Slot) => void)[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly size: number,
    private readonly databaseUrl: string,
  ) {
    if (!(Number.isInteger(size) && size > 0))
      throw new RangeError("StageWorkerPool size must be ≥ 1");
  }

  /** Worker threads started so far. */
  get started(): number {
    return this.slots.length;
  }

  async run(stage: DbStage, ctx: StageCtx): Promise<q.Json> {
    if (this.closed) throw new Error("the stage worker pool is closed");
    const slot = await this.acquire();
    try {
      return await new Promise<q.Json>((resolve, reject) => {
        const id = this.nextId++;
        slot.pending = { id, resolve, reject };
        slot.worker.postMessage({ id, stage, ctx } satisfies StageRequest);
      });
    } finally {
      slot.pending = null;
      this.releaseSlot(slot);
    }
  }

  private acquire(): Promise<Slot> {
    const free = this.slots.find((s) => !s.busy);
    if (free !== undefined) {
      free.busy = true;
      return Promise.resolve(free);
    }
    if (this.slots.length < this.size) {
      const slot = this.spawn();
      slot.busy = true;
      return Promise.resolve(slot);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private releaseSlot(slot: Slot): void {
    if (!this.slots.includes(slot)) {
      // It died: start a replacement for whoever is waiting.
      const next = this.waiting.shift();
      if (next !== undefined && !this.closed) {
        const fresh = this.spawn();
        fresh.busy = true;
        next(fresh);
      }
      return;
    }
    const next = this.waiting.shift();
    if (next !== undefined) next(slot);
    else slot.busy = false;
  }

  private spawn(): Slot {
    const fromSource = import.meta.url.endsWith(".ts");
    const entry = new URL(fromSource ? "./stage-worker.ts" : "./stage-worker.js", import.meta.url);
    const data: StageWorkerData = fromSource
      ? { databaseUrl: this.databaseUrl, entry: entry.href }
      : { databaseUrl: this.databaseUrl };
    const worker = new Worker(
      fromSource ? new URL("./worker-bootstrap.mjs", import.meta.url) : entry,
      { workerData: data },
    );
    const slot: Slot = { worker, busy: false, pending: null };
    worker.on("message", (reply: StageReply) => {
      const p = slot.pending;
      if (p === null || p.id !== reply.id) return;
      if (reply.ok) p.resolve(reply.detail);
      else p.reject(new Error(reply.error));
    });
    const die = (e: Error) => {
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots.splice(i, 1);
      slot.pending?.reject(e);
    };
    worker.on("error", die);
    worker.on("exit", (code) => die(new Error(`stage worker exited (code ${code})`)));
    this.slots.push(slot);
    return slot;
  }

  /** Let the workers finish their pools, then stop them. */
  async close(): Promise<void> {
    this.closed = true;
    const slots = this.slots.splice(0);
    await Promise.all(
      slots.map(
        (s) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => void s.worker.terminate().then(() => resolve()), 5_000);
            s.worker.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            s.worker.postMessage("close");
          }),
      ),
    );
  }
}
