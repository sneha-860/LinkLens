// Worker entry when running from TypeScript sources (tsx, vitest): Node's worker threads do not
// inherit the parent's TypeScript loader, so register tsx here and then load the real worker.
import { workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
await import(workerData.entry);
