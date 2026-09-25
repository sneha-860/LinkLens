import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postCsv, postJson } from "./client.js";
import type {
  Audit,
  AuditListItem,
  CreateAuditRequest,
  CreateAuditResponse,
  DiagnosisCase,
  DiagnosisResponse,
  FixesResponse,
  GraphResponse,
  OrphansResponse,
  Policy,
  SensitivityResponse,
  SigmaVariant,
  Summary,
} from "./types.js";

export const keys = {
  audits: ["audits"] as const,
  audit: (id: number) => ["audit", id] as const,
};

/** Results do not change once computed; the audit's queries are invalidated when it finishes. */
const results = { staleTime: Infinity, retry: false } as const;

export const useAudits = () =>
  useQuery({
    queryKey: keys.audits,
    queryFn: () => api<{ audits: AuditListItem[] }>("/audits").then((r) => r.audits),
    refetchInterval: 5_000,
  });

export const useAudit = (id: number) =>
  useQuery({ queryKey: keys.audit(id), queryFn: () => api<Audit>(`/audits/${id}`) });

export const useSummary = (id: number) =>
  useQuery({
    queryKey: [...keys.audit(id), "summary"],
    queryFn: () => api<Summary>(`/audits/${id}/summary`),
    ...results,
  });

export const useFixes = (
  id: number,
  sigma: SigmaVariant,
  k: 10 | 25 | 50,
  scope: "global" | "target",
  enabled = true,
) =>
  useQuery({
    queryKey: [...keys.audit(id), "fixes", sigma, k, scope],
    queryFn: () => api<FixesResponse>(`/audits/${id}/fixes?sigma=${sigma}&k=${k}&scope=${scope}`),
    enabled,
    ...results,
  });

export const useDiagnosis = (id: number) =>
  useQuery({
    queryKey: [...keys.audit(id), "diagnosis"],
    queryFn: () => api<DiagnosisResponse>(`/audits/${id}/diagnosis`),
    ...results,
  });

export const useOrphans = (id: number) =>
  useQuery({
    queryKey: [...keys.audit(id), "orphans"],
    queryFn: () => api<OrphansResponse>(`/audits/${id}/orphans`),
    ...results,
  });

export const useGraph = (id: number, policy: Policy) =>
  useQuery({
    queryKey: [...keys.audit(id), "graph", policy],
    queryFn: () => api<GraphResponse>(`/audits/${id}/graph?policy=${policy}`),
    ...results,
  });

export const useSensitivity = (id: number, enabled = true) =>
  useQuery({
    queryKey: [...keys.audit(id), "sensitivity"],
    queryFn: () => api<SensitivityResponse>(`/audits/${id}/sensitivity`),
    enabled,
    ...results,
  });

/** A file's text: Blob.text() where available, else FileReader (older browsers, jsdom). */
export function readText(file: Blob): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.readAsText(file);
  });
}

/** Create an audit, then upload its analytics CSV (if any) before the pipeline reaches it. */
export function useCreateAudit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { request: CreateAuditRequest; csv?: File | null }) => {
      const created = await postJson<CreateAuditResponse>("/audits", input.request);
      if (input.csv) {
        await postCsv(
          `/audits/${created.id}/analytics?name=${encodeURIComponent(input.csv.name)}`,
          await readText(input.csv),
        );
      }
      return created;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.audits }),
  });
}

export function useResumeAudit(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ status: string }>(`/audits/${id}/resume`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.audit(id) }),
  });
}

export type { DiagnosisCase };
