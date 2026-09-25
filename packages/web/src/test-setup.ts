import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
});
