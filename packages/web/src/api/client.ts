/** Where the API is: the Vite dev proxy maps /api to the API server. */
export const API_BASE = (import.meta.env["VITE_API_BASE"] as string | undefined) ?? "/api";

/** An API error (`{ error: { code, message, details? } }`) or a network failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new ApiError(0, "network", "cannot reach the LinkLens API");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? "http_error",
      body?.error?.message ?? `request failed (${res.status})`,
      body?.error?.details,
    );
  }
  return (await res.json()) as T;
}

export const postJson = <T>(path: string, body: unknown) =>
  api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const postCsv = <T>(path: string, csv: string) =>
  api<T>(path, { method: "POST", headers: { "Content-Type": "text/csv" }, body: csv });

export const exportUrl = (id: number) => `${API_BASE}/audits/${id}/export`;
export const eventsUrl = (id: number) => `${API_BASE}/audits/${id}/events`;
