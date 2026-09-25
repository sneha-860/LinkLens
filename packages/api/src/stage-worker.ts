// A stage worker thread: runs database-only pipeline stages (see stages.ts) with its own
// connection pool, one request at a time, so the API's event loop is not blocked by them.
import { parentPort, workerData } from "node:worker_threads";
import { asQueryable, createPool } from "@linklens/db";
import { dbStages } from "./stages.js";
import type { StageReply, StageRequest, StageWorkerData } from "./stage-pool.js";

const { databaseUrl } = workerData as StageWorkerData;
const pool = createPool(databaseUrl);
pool.on("error", () => undefined); // an idle client's error must not kill the thread
const db = asQueryable(pool);
const port = parentPort;
if (port === null) throw new Error("stage-worker must run in a worker thread");

port.on("message", (msg: StageRequest | "close") => {
  if (msg === "close") {
    void pool.end().finally(() => port.close());
    return;
  }
  dbStages[msg.stage](db, msg.ctx).then(
    (detail) => port.postMessage({ id: msg.id, ok: true, detail } satisfies StageReply),
    (e: unknown) =>
      port.postMessage({
        id: msg.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } satisfies StageReply),
  );
});
