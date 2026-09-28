import { useState } from "react";
import {
  useCreateRatingSample,
  useRating,
  useRatingSummary,
  useSaveRating,
} from "../../api/queries.js";
import type {
  BlindItem,
  Placement,
  PrecisionAtK,
  Rater,
  RatingAnswer,
  RatingSummary,
} from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { fmt2, shortUrl } from "../../ui/format.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ProgressBar,
  QueryView,
} from "../../ui/ui.js";
import { AnchorBlock } from "../fixes/FixRow.js";

const STORE = "linklens:rater";
const PLACEMENTS: { value: Placement; label: string }[] = [
  { value: "good", label: "Good" },
  { value: "acceptable", label: "Acceptable" },
  { value: "poor", label: "Poor" },
  { value: "na", label: "N/A" },
];

/** This browser's rater slot and name (a convenience only; the server keeps the answers). */
function loadRater(): { rater: Rater | null; name: string } {
  try {
    const raw = window.localStorage.getItem(STORE);
    const v = raw === null ? null : (JSON.parse(raw) as { rater?: Rater; name?: string });
    return { rater: v?.rater === "A" || v?.rater === "B" ? v.rater : null, name: v?.name ?? "" };
  } catch {
    return { rater: null, name: "" };
  }
}
function saveRater(v: { rater: Rater | null; name: string }): void {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(v));
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

/**
 * E8: two raters mark a blind sample of top fixes (no scores, ranks or explanations) as relevant
 * or not, and the suggested placement as good / acceptable / poor (n/a when not relevant or
 * when nothing was suggested). Results (precision@k, Cohen's kappa) are folded away so they do
 * not bias the rating.
 */
export function RatingTab() {
  const audit = useCurrentAudit();
  const [who, setWho] = useState(loadRater);
  const rating = useRating(audit.id, who.rater);
  const create = useCreateRatingSample(audit.id);
  const update = (v: typeof who) => {
    setWho(v);
    saveRater(v);
  };

  return (
    <QueryView query={rating}>
      {(r) => {
        if (r.sample === null) {
          return (
            <Card title="Human rating">
              <EmptyState title="No rating sample yet">
                {r.canCreate ? (
                  <>
                    <p>
                      Draw a blind sample of the top fixes. Both raters rate the same sample,
                      without scores or explanations.
                    </p>
                    <Button onClick={() => create.mutate()} disabled={create.isPending}>
                      {create.isPending ? "Drawing…" : "Draw the rating sample"}
                    </Button>
                    {create.error && <ErrorState error={create.error} />}
                  </>
                ) : (
                  <p>
                    The sample is drawn from the ranked fixes, once the pipeline has scored them.
                  </p>
                )}
              </EmptyState>
            </Card>
          );
        }
        const sample = r.sample;
        const answers = r.answers ?? {};
        const done = sample.items.filter((i) => answers[i.itemId] !== undefined).length;
        const ready = who.rater !== null && who.name.trim() !== "";
        return (
          <div className="grid">
            <Card title="Human rating">
              <p className="field-hint" style={{ marginTop: 0 }}>
                {sample.size} recommendations, in random order, without scores. For each, say
                whether the link belongs, then how good the suggested place and anchor are. Rate on
                your own: you never see the other rater's answers.
              </p>
              <fieldset className="rater-pick">
                <legend>You are</legend>
                {(["A", "B"] as const).map((slot) => (
                  <label key={slot} className="choice">
                    <input
                      type="radio"
                      name="rater"
                      checked={who.rater === slot}
                      onChange={() => update({ ...who, rater: slot })}
                    />
                    Rater {slot}
                  </label>
                ))}
                <label className="rater-name">
                  Name{" "}
                  <input
                    value={who.name}
                    onChange={(e) => update({ ...who, name: e.target.value })}
                    placeholder="Your name"
                    maxLength={100}
                  />
                </label>
              </fieldset>
              {ready ? (
                <div className="rating-progress">
                  <ProgressBar fraction={done / sample.size} label="Items rated" />
                  <span>
                    {done} of {sample.size} rated
                  </span>
                </div>
              ) : (
                <p className="field-hint">Choose your rater slot and enter your name to start.</p>
              )}
            </Card>
            {ready &&
              sample.items.map((item) => (
                <RatingItemCard
                  key={item.itemId}
                  auditId={audit.id}
                  item={item}
                  rater={who.rater as Rater}
                  name={who.name.trim()}
                  saved={answers[item.itemId]}
                />
              ))}
            <ResultsCard auditId={audit.id} />
          </div>
        );
      }}
    </QueryView>
  );
}

function PageRef({ label, url, title }: { label: string; url: string; title: string | null }) {
  return (
    <div className="rating-page">
      <span className="rating-page-label">{label}</span>
      <a href={url} target="_blank" rel="noreferrer noopener">
        {title ?? shortUrl(url)}
      </a>
      {title !== null && <span className="rating-page-url">{shortUrl(url)}</span>}
    </div>
  );
}

function RatingItemCard({
  auditId,
  item,
  rater,
  name,
  saved,
}: {
  auditId: number;
  item: BlindItem;
  rater: Rater;
  name: string;
  saved: RatingAnswer | undefined;
}) {
  const save = useSaveRating(auditId);
  // A relevance chosen but not yet saved (a relevant item waits for its placement).
  const [draft, setDraft] = useState<boolean | null>(null);
  const relevant = draft ?? saved?.relevant ?? null;
  const placed = item.placement?.status === "suggested";
  const send = (answer: RatingAnswer) =>
    save.mutate(
      { ...answer, itemId: item.itemId, rater, name },
      { onSuccess: () => setDraft(null) },
    );
  const group = `item-${item.position}`;

  return (
    <section className="card rating-item" aria-labelledby={`${group}-title`}>
      <header className="card-header">
        <h2 className="card-title" id={`${group}-title`}>
          Recommendation {item.position}
        </h2>
        <span className="rating-state">
          {save.isPending ? (
            "Saving…"
          ) : saved !== undefined && draft === null ? (
            <Badge tone="success">Saved</Badge>
          ) : null}
        </span>
      </header>
      <p className="rating-action">
        <Badge tone="info">
          {item.action === "make-visible" ? "Make the link more visible" : "Add a link"}
        </Badge>
      </p>
      <PageRef label="From" url={item.donor} title={item.donorTitle} />
      <PageRef label="To" url={item.target} title={item.targetTitle} />
      {item.placement !== null ? (
        <AnchorBlock anchor={item.placement} blind />
      ) : (
        <p className="anchor-none">No placement was suggested.</p>
      )}
      <div className="rating-controls">
        <fieldset>
          <legend>Does this link belong?</legend>
          <label className="choice">
            <input
              type="radio"
              name={`${group}-relevant`}
              checked={relevant === true}
              onChange={() => {
                setDraft(true);
                // Nothing to judge about the placement: save at once as n/a.
                if (!placed) send({ relevant: true, placement: "na" });
              }}
            />
            Relevant
          </label>
          <label className="choice">
            <input
              type="radio"
              name={`${group}-relevant`}
              checked={relevant === false}
              onChange={() => {
                setDraft(false);
                send({ relevant: false, placement: "na" });
              }}
            />
            Not relevant
          </label>
        </fieldset>
        <fieldset disabled={relevant !== true || !placed}>
          <legend>Placement quality</legend>
          {PLACEMENTS.map((p) => (
            <label key={p.value} className="choice">
              <input
                type="radio"
                name={`${group}-placement`}
                checked={
                  relevant === true && saved?.relevant === true && saved.placement === p.value
                }
                onChange={() => send({ relevant: true, placement: p.value })}
              />
              {p.label}
            </label>
          ))}
        </fieldset>
      </div>
      {save.error && <ErrorState error={save.error} />}
    </section>
  );
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const kappa = (x: number | null) => (x === null ? "—" : fmt2(x));

function PrecisionRow({
  label,
  rows,
}: {
  label: string;
  rows: (PrecisionAtK | { k: number; precision: number | null })[];
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      {rows.map((p) => (
        <td key={p.k} className="num">
          {pct(p.precision)}
          {"rated" in p && <span className="field-hint"> ({p.rated})</span>}
        </td>
      ))}
    </tr>
  );
}

/** Precision@k and agreement, folded away until opened (so they do not bias the raters). */
function ResultsCard({ auditId }: { auditId: number }) {
  const [open, setOpen] = useState(false);
  const summary = useRatingSummary(auditId, open);
  return (
    <Card title="Results">
      <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Show precision@k and agreement (open once both raters are done)</summary>
        {open && <QueryView query={summary}>{(s) => <Results s={s} />}</QueryView>}
      </details>
    </Card>
  );
}

function Results({ s }: { s: RatingSummary }) {
  const name = (r: RatingSummary["raters"][number]) =>
    `Rater ${r.rater}${r.name ? ` (${r.name})` : ""}`;
  return (
    <div className="rating-results">
      <div className="table-scroll">
        <table>
          <caption>
            Precision@k: share of the rated top-k fixes judged relevant (rated items in brackets)
          </caption>
          <thead>
            <tr>
              <th scope="col">Rater</th>
              {s.ks.map((k) => (
                <th key={k} scope="col" className="num">
                  P@{k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.raters.map((r) => (
              <PrecisionRow key={r.rater} label={name(r)} rows={r.precisionAtK} />
            ))}
            <PrecisionRow label="Both (relevant to both)" rows={s.consensus.strict} />
            <PrecisionRow label="Mean of the two" rows={s.consensus.mean} />
          </tbody>
        </table>
      </div>
      <dl className="props props-inline">
        <dt>Rated by both</dt>
        <dd>
          {s.agreement.items} of {s.items}
        </dd>
        <dt>Relevance agreement</dt>
        <dd>
          {pct(s.agreement.relevance.observed)} · Cohen's κ {kappa(s.agreement.relevance.kappa)}
        </dd>
        <dt>Placement agreement</dt>
        <dd>
          {pct(s.agreement.placement.observed)} · κ {kappa(s.agreement.placement.kappa)} · weighted
          κ {kappa(s.agreement.placement.weightedKappa)} ({s.agreement.placement.items} items both
          marked relevant)
        </dd>
      </dl>
    </div>
  );
}
