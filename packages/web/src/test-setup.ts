import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// React Router builds a Request for each navigation with jsdom's AbortSignal, which Node's
// Request refuses ("Expected signal to be an instance of AbortSignal"). Tests do not abort
// navigations, so drop the signal.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {};
    super(input, rest);
  }
} as typeof Request;

// findBy*/waitFor wait up to 1 s by default, too little under a parallel run (see vite.config).
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
});
