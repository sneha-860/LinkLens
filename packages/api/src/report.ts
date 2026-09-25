import { audit as auditCore, canonicalise, db as q, diagnosis, fixes } from "@linklens/core";
import { auditView, latest, summaryView } from "./views.js";

type PolicyId = canonicalise.PolicyId;

/** HTML-escape text (every dynamic value in the report goes through this). */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const path = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};
const sci = (x: number) => `${x >= 0 ? "+" : ""}${x.toExponential(2)}`;
const f2 = (x: number) => x.toFixed(2);

const STYLE = `
  body { font: 14px/1.5 system-ui, sans-serif; color: #1c1c1a; max-width: 900px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .muted { color: #6b6b66; } table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { color: #6b6b66; font-weight: 600; font-size: 12px; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .stat { border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; } .stat b { font-size: 20px; display: block; }
  .pair { font-family: ui-monospace, Consolas, monospace; font-size: 12px; } ul.why { margin: 4px 0 0; padding-left: 18px; color: #555; font-size: 12px; }
  .fix { break-inside: avoid; } .print { float: right; }
  @media print { .print { display: none; } body { margin: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
`;

/**
 * A printable, self-contained HTML report of an audit (whatever the pipeline has produced):
 * summary, issues, the top fixes with their explanations, the diagnosis and the orphans.
 */
export async function reportHtml(db: q.Queryable, a: q.AuditRow, active: boolean): Promise<string> {
  const policy = a.policy as PolicyId;
  const [status, summary, issues, diag, ranking, rescue, expl] = await Promise.all([
    auditView(db, a, active),
    summaryView(db, a, active),
    latest<auditCore.StructuralAudit>(db, a.runId, auditCore.STRUCTURAL_AUDIT_ARTEFACT, policy),
    latest<diagnosis.DiagnosisReport>(db, a.runId, diagnosis.DIAGNOSIS_ARTEFACT, policy),
    latest<fixes.FixRanking>(db, a.runId, fixes.FIX_RANKING_ARTEFACT, policy),
    latest<{ orphans: fixes.RescuedOrphan[] }>(db, a.runId, fixes.RESCUE_ARTEFACT, policy),
    latest<fixes.ExplanationSet>(db, a.runId, fixes.EXPLANATIONS_ARTEFACT, policy),
  ]);
  const whyFix = new Map((expl?.payload.fixes ?? []).map((e) => [e.id, e.lines]));
  const whyDiag = new Map((expl?.payload.diagnoses ?? []).map((e) => [e.id, e.sentence]));
  const stat = (label: string, value: unknown) =>
    `<div class="stat"><b>${esc(value)}</b>${esc(label)}</div>`;
  const parts: string[] = [];

  parts.push(`<button class="print" onclick="window.print()">Print / save as PDF</button>
<h1>LinkLens audit: ${esc(a.rootUrl)}</h1>
<p class="muted">Audit #${esc(a.runId)} · policy ${esc(a.policy)} · status ${esc(a.status)} ·
${esc(status.progress.completedStages)} of ${esc(status.progress.totalStages)} stages · started ${esc(a.createdAt.toISOString())}</p>
<div class="stats">
${stat("pages crawled", summary.pages)}${stat("graph nodes", summary.graph?.["nodes"] ?? "—")}
${stat("issues", summary.issues?.total ?? "—")}${stat("orphans", summary.discovery?.orphans ?? "—")}
</div>`);

  if (issues !== null) {
    const s = issues.payload.summary;
    parts.push(`<h2>Issues</h2>
<p>${esc(s.bySeverity.high)} high, ${esc(s.bySeverity.medium)} medium, ${esc(s.bySeverity.low)} low, on ${esc(s.nodesWithIssues)} pages.</p>
<table><tr><th>Type</th><th class="num">Count</th></tr>
${Object.entries(s.byType)
  .map(([t, n]) => `<tr><td>${esc(t)}</td><td class="num">${esc(n)}</td></tr>`)
  .join("\n")}</table>`);
  }

  if (ranking !== null) {
    const top = ranking.payload.fixes.slice(0, 25);
    parts.push(`<h2>Top ${top.length} fixes</h2>
<p class="muted">Ranked by S = ΔPR × σ / κ with σ = ${esc(ranking.payload.sigmaVariant)}; ${esc(ranking.payload.fixes.length)} fixes in all.</p>
<table><tr><th class="num">#</th><th>Link</th><th class="num">ΔPR</th><th class="num">Δdepth</th><th class="num">κ</th></tr>
${top
  .map(
    (
      f,
    ) => `<tr class="fix"><td class="num">${esc(f.rank)}</td><td><span class="pair">${esc(path(f.donor))} → ${esc(path(f.target))}</span>
 (${esc(f.type === "add-link" ? "add link" : "make visible")})
 ${(whyFix.get(f.id) ?? []).length > 0 ? `<ul class="why">${(whyFix.get(f.id) ?? []).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}</td>
<td class="num">${esc(sci(f.deltaPr))}</td><td class="num">${esc(f.deltaDepth ?? "—")}</td><td class="num">${esc(f.kappa)}</td></tr>`,
  )
  .join("\n")}</table>`);
  }

  if (diag !== null) {
    const c = diag.payload.counts;
    const worst = diag.payload.diagnoses
      .filter((d) => d.case === "v4" || d.case === "v3" || d.case === "v1")
      .slice(0, 20);
    parts.push(`<h2>Diagnosis</h2>
<p>${esc(c.v4)} missing (v4), ${esc(c.v3)} buried (v3), ${esc(c.v2)} good (v2), ${esc(c.v1)} misleading (v1) among ${esc(c.pairs)} pairs (α ${esc(diag.payload.alpha)}).</p>
<table><tr><th>Case</th><th>Pair and why</th><th class="num">Severity</th></tr>
${worst
  .map(
    (
      d,
    ) => `<tr><td>${esc(d.case)}</td><td><span class="pair">${esc(path(d.source))} → ${esc(path(d.target))}</span>
<div class="muted">${esc(whyDiag.get(d.id) ?? "")}</div></td><td class="num">${esc(f2(d.severity))}</td></tr>`,
  )
  .join("\n")}</table>`);
  }

  if (rescue !== null) {
    parts.push(`<h2>Orphans</h2>
<table><tr><th>Orphan</th><th>Found via</th><th>Best rescue donors</th></tr>
${rescue.payload.orphans
  .map(
    (o) => `<tr><td class="pair">${esc(path(o.node))}</td><td>${esc(o.revealedBy.join(", "))}</td>
<td>${o.donors.length === 0 ? '<span class="muted">none</span>' : o.donors.map((d) => `<span class="pair">${esc(path(d.donor))}</span> (REF ${esc(f2(d.ref))}, ΔPR ${esc(sci(d.deltaPr))})`).join("<br>")}</td></tr>`,
  )
  .join("\n")}</table>`);
  }

  parts.push(`<h2>Pipeline</h2>
<table><tr><th>Stage</th><th>Status</th><th class="num">Time</th></tr>
${status.stages
  .map(
    (s) =>
      `<tr><td>${esc(s.stage)}</td><td>${esc(s.status)}</td><td class="num">${esc(s.durationMs === null ? "" : `${Math.round(s.durationMs)} ms`)}</td></tr>`,
  )
  .join("\n")}</table>
<p class="muted">Generated by LinkLens. Explanations are deterministic templates over the audit's stored evidence.</p>`);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>LinkLens audit #${esc(a.runId)} – ${esc(a.rootUrl)}</title>
<style>${STYLE}</style></head><body>
${parts.join("\n")}
</body></html>
`;
}
