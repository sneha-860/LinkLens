import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { eventsUrl } from "./client.js";
import { keys } from "./queries.js";
import type { Audit, AuditEvent, StageStatus } from "./types.js";

export interface LiveStage {
  stage: string;
  status: StageStatus;
  durationMs: number | null;
  error: string | null;
}

export interface LiveState {
  stages: LiveStage[];
  crawl: { pagesFetched: number; admitted: number; url: string } | null;
  /** Receiving server-sent events right now. */
  connected: boolean;
  done: boolean;
}

export const isFinished = (a: Audit) =>
  !a.active && (a.status === "completed" || a.status === "failed");

export const fromAudit = (a: Audit): LiveState => ({
  stages: a.stages.map((s) => ({
    stage: s.stage,
    status: s.status,
    durationMs: s.durationMs,
    error: s.error,
  })),
  crawl: null,
  connected: false,
  done: isFinished(a),
});

/** Pure: apply one server-sent event to the live state. */
export function applyEvent(state: LiveState, e: AuditEvent): LiveState {
  switch (e.type) {
    case "stage":
      return {
        ...state,
        stages: state.stages.map((s) =>
          s.stage !== e.stage
            ? s
            : {
                ...s,
                status: e.status,
                durationMs: e.status === "running" ? null : e.durationMs,
                error: e.status === "failed" ? e.error : null,
              },
        ),
      };
    case "progress":
      return {
        ...state,
        crawl: { pagesFetched: e.pagesFetched, admitted: e.admitted, url: e.url },
      };
    case "done":
    case "idle":
      return { ...state, done: true };
  }
}

/**
 * Live progress of an audit: its stages, updated by server-sent events. When the audit is done
 * its queries are invalidated so the results appear. If the stream drops, the audit is polled.
 */
export function useAuditEvents(audit: Audit | undefined): LiveState | null {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState | null>(null);
  const id = audit?.id;
  const finished = audit !== undefined && isFinished(audit);

  // Seed from the audit; once it has finished (or while not streaming) follow the audit query.
  useEffect(() => {
    if (audit !== undefined)
      setState((s) => (s === null || finished || !s.connected ? fromAudit(audit) : s));
  }, [audit, finished]);

  useEffect(() => {
    if (id === undefined || finished || typeof EventSource === "undefined") return;
    const source = new EventSource(eventsUrl(id));
    let poll: ReturnType<typeof setInterval> | undefined;
    const handle = (type: string) => (m: Event) => {
      const data = JSON.parse((m as MessageEvent<string>).data) as unknown;
      if (type === "snapshot") {
        setState({ ...fromAudit(data as Audit), connected: true });
        return;
      }
      setState((s) => (s === null ? s : { ...applyEvent(s, data as AuditEvent), connected: true }));
      if (type === "done" || type === "idle") {
        source.close();
        void qc.invalidateQueries({ queryKey: keys.audit(id) });
        void qc.invalidateQueries({ queryKey: keys.audits });
      }
    };
    for (const type of ["snapshot", "stage", "progress", "done", "idle"]) {
      source.addEventListener(type, handle(type));
    }
    source.onerror = () => {
      source.close();
      setState((s) => (s === null ? s : { ...s, connected: false }));
      poll = setInterval(() => void qc.invalidateQueries({ queryKey: keys.audit(id) }), 2_000);
    };
    return () => {
      source.close();
      if (poll !== undefined) clearInterval(poll);
    };
  }, [id, finished, qc]);

  return state;
}
