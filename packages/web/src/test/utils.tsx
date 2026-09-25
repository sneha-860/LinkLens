import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";
import { routes } from "../router.js";
import type { Audit, Fix } from "../api/types.js";

export type Handler = (init: RequestInit | undefined, url: URL) => unknown;

/** The session of a server without an API key (what `GET /session` answers unless mocked). */
const OPEN_SESSION = { authRequired: false, authenticated: true };

/**
 * Mock `fetch`: `routes` maps "METHOD /path" (the path after /api, without the query) to a
 * response body or a handler; `{ status, body }` sends an error. Calls are recorded in order,
 * except the sign-in gate's `GET /session`, which answers "no key needed" unless mocked.
 */
export function mockApi(routesByKey: Record<string, unknown>) {
  const calls: { method: string; path: string; search: string; body: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api/, "");
    const key = `${method} ${path}`;
    if (key === "GET /session" && !(key in routesByKey))
      return new Response(JSON.stringify(OPEN_SESSION), { status: 200 });
    calls.push({ method, path, search: url.search, body: init?.body });
    if (!(key in routesByKey)) {
      return new Response(
        JSON.stringify({ error: { code: "not_found", message: `no mock for ${key}` } }),
        {
          status: 404,
        },
      );
    }
    let value = routesByKey[key];
    if (typeof value === "function") value = (value as Handler)(init, url);
    if (value !== null && typeof value === "object" && "status" in value && "body" in value) {
      const v = value as { status: number; body: unknown };
      return new Response(v.status === 204 ? null : JSON.stringify(v.body), { status: v.status });
    }
    return new Response(JSON.stringify(value), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

/** A controllable EventSource: tests push events with `emit`. */
export class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, l: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? [])
      l(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

export function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, client };
}

export const STAGE_NAMES = [
  "crawl",
  "extract",
  "discovery",
  "canonicalise",
  "graph",
  "reconcile",
  "issues",
  "text",
  "ref",
  "embeddings",
  "prominence",
  "diagnosis",
  "candidates",
  "counterfactual",
  "kappa",
  "scoring",
  "rescue",
  "explanations",
];

export function audit(overrides: Partial<Audit> = {}, done = STAGE_NAMES.length): Audit {
  return {
    id: 7,
    url: "https://example.com/",
    policy: "P3",
    status: "completed",
    currentStage: null,
    createdAt: "2026-09-26T10:00:00Z",
    updatedAt: "2026-09-26T10:05:00Z",
    options: {},
    active: false,
    error: null,
    crawl: { status: "completed", pageCap: 500, urlsFetched: 42 },
    progress: {
      completedStages: done,
      totalStages: STAGE_NAMES.length,
      fraction: done / STAGE_NAMES.length,
    },
    stages: STAGE_NAMES.map((stage, i) => ({
      stage,
      status: i < done ? "completed" : "pending",
      startedAt: null,
      finishedAt: null,
      durationMs: i < done ? 100 * (i + 1) : null,
      detail: {},
      error: null,
    })),
    ...overrides,
  };
}

export function fix(rank: number, overrides: Partial<Fix> = {}): Fix {
  return {
    id: `add-link:https://example.com/d${rank}->https://example.com/t${rank}`,
    donor: `https://example.com/d${rank}`,
    target: `https://example.com/t${rank}`,
    type: "add-link",
    prBefore: 0.01,
    prAfter: 0.012,
    deltaPr: 0.002,
    deltaDepth: -2,
    depthBefore: 5,
    depthAfter: 3,
    sigmaVariant: "refGateCosine",
    sigma: 0.8,
    sigmas: { refGateCosine: 0.8, cosineOnly: 0.8, refOnly: 0.5, blended: 0.65 },
    ref: 0.5,
    cosine: 0.8,
    kappa: 1,
    templateReach: 1,
    score: 0.0016 / rank,
    rank,
    targetRank: 1,
    diagnosis: "v4",
    policyVersion: "P3@1.0.0",
    explanation: {
      sentence: `Add a link from /d${rank} to /t${rank}.`,
      lines: [
        `Why the target: /t${rank} is 5 clicks deep.`,
        "Why this donor: REF 0.50.",
        "Case: v4 (missing).",
      ],
    },
    ...overrides,
  };
}
