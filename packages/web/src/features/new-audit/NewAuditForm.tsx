import { useState, type FormEvent } from "react";
import { ApiError } from "../../api/client.js";
import { useCreateAudit } from "../../api/queries.js";
import { POLICIES, SIGMA_VARIANTS, type Policy, type SigmaVariant } from "../../api/types.js";
import { SIGMA_NAMES } from "../../ui/format.js";
import { Button } from "../../ui/ui.js";

const POLICY_HINTS: Record<Policy, string> = {
  P0: "P0 — RFC 3986 normalisation only",
  P1: "P1 — + no fragment, no trailing slash",
  P2: "P2 — + no tracking parameters",
  P3: "P3 — + no query; http/https and www. merged",
  P4: "P4 — + follow redirects",
  P5: "P5 — + follow rel=canonical",
};

export interface NewAuditValues {
  url: string;
  pageCap: number;
  policy: Policy;
  sigma: SigmaVariant;
  csv: File | null;
}

/** Client-side checks (the API validates again). */
export function validate(v: {
  url: string;
  pageCap: string;
}): Partial<Record<"url" | "pageCap", string>> {
  const errors: Partial<Record<"url" | "pageCap", string>> = {};
  try {
    const u = new URL(v.url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:")
      errors.url = "Use an http:// or https:// address.";
  } catch {
    errors.url = "Enter the site's full address, e.g. https://example.com/";
  }
  const cap = Number(v.pageCap);
  if (!Number.isInteger(cap) || cap < 1 || cap > 500)
    errors.pageCap = "A whole number from 1 to 500.";
  return errors;
}

export function NewAuditForm({ onCreated }: { onCreated: (id: number) => void }) {
  const [url, setUrl] = useState("");
  const [pageCap, setPageCap] = useState("500");
  const [policy, setPolicy] = useState<Policy>("P3");
  const [sigma, setSigma] = useState<SigmaVariant>("refGateCosine");
  const [csv, setCsv] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const create = useCreateAudit();
  const errors = validate({ url, pageCap });
  const show = (k: "url" | "pageCap") => (touched ? errors[k] : undefined);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    create.mutate(
      {
        request: { url: url.trim(), pageCap: Number(pageCap), policy, options: { sigma } },
        csv,
      },
      { onSuccess: (r) => onCreated(r.id) },
    );
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="url">Site URL</label>
        <input
          id="url"
          type="url"
          placeholder="https://example.com/"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={show("url") !== undefined}
          aria-describedby="url-error"
        />
        {show("url") && (
          <span id="url-error" className="field-error">
            {show("url")}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="pageCap">Page cap</label>
        <input
          id="pageCap"
          type="number"
          min={1}
          max={500}
          value={pageCap}
          onChange={(e) => setPageCap(e.target.value)}
          aria-invalid={show("pageCap") !== undefined}
        />
        {show("pageCap") ? (
          <span className="field-error">{show("pageCap")}</span>
        ) : (
          <span className="field-hint">At most 500 URLs are crawled.</span>
        )}
      </div>

      <div className="field">
        <label htmlFor="policy">Canonicalisation policy</label>
        <select id="policy" value={policy} onChange={(e) => setPolicy(e.target.value as Policy)}>
          {POLICIES.map((p) => (
            <option key={p} value={p}>
              {POLICY_HINTS[p]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="sigma">σ variant (fix scoring)</label>
        <select id="sigma" value={sigma} onChange={(e) => setSigma(e.target.value as SigmaVariant)}>
          {SIGMA_VARIANTS.map((s) => (
            <option key={s} value={s}>
              {SIGMA_NAMES[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="csv">Analytics CSV (optional)</label>
        <input
          id="csv"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setCsv(e.target.files?.[0] ?? null)}
        />
        <span className="field-hint">
          Columns <code>source_url, target_url, clicks</code>. Clicks replace the structural
          prominence for the pages they cover.
        </span>
      </div>

      {create.error && (
        <div className="error" role="alert">
          {create.error instanceof ApiError ? create.error.message : "Could not start the audit."}
        </div>
      )}
      <div className="row">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Starting…" : "Start audit"}
        </Button>
      </div>
    </form>
  );
}
