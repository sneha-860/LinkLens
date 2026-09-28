import { Fragment, useState } from "react";
import { useLinkHealth } from "../../api/queries.js";
import type { BrokenTarget, LinkSource, RedirectChain } from "../../api/types.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { fmtInt, shortUrl } from "../../ui/format.js";
import { Badge, Button, Card, EmptyState, QueryView, StatCard, type Tone } from "../../ui/ui.js";

const PAGE = 100;

const statusTone = (status: number | null): Tone =>
  status === null
    ? "neutral"
    : status >= 500
      ? "danger"
      : status >= 400
        ? "warning"
        : status >= 300
          ? "info"
          : "success";

function Status({ status }: { status: number | null }) {
  return <Badge tone={statusTone(status)}>{status ?? "no answer"}</Badge>;
}

function UrlLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" title={url} className="link-url">
      {shortUrl(url)}
    </a>
  );
}

/** The pages that link to a target: where to fix it, with the anchors and page regions. */
function Sources({ sources }: { sources: LinkSource[] }) {
  return (
    <ul className="link-sources">
      {sources.map((s) => (
        <li key={s.page}>
          <UrlLink url={s.page} />
          {s.links > 1 && <span className="field-hint"> ×{s.links}</span>}
          {s.anchors.length > 0 && (
            <span className="link-anchors"> {s.anchors.map((a) => `“${a}”`).join(", ")}</span>
          )}{" "}
          {s.regions.map((r) => (
            <Badge key={r}>{r}</Badge>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** A redirect chain as its hops: each URL with the status it answered, then where it ended. */
function Chain({ t }: { t: RedirectChain | BrokenTarget }) {
  return (
    <ol className="link-chain">
      {t.chain.map((h) => (
        <li key={h.url}>
          <UrlLink url={h.url} /> <Status status={h.statusCode} />
        </li>
      ))}
      <li>
        {t.finalUrl === null ? "—" : <UrlLink url={t.finalUrl} />} <Status status={t.finalStatus} />
        {t.error !== null && <span className="field-hint"> {t.error}</span>}
      </li>
    </ol>
  );
}

function ExpandButton({ open, onClick, n }: { open: boolean; onClick: () => void; n: number }) {
  return (
    <button type="button" className="linklike" aria-expanded={open} onClick={onClick}>
      {n} page{n === 1 ? "" : "s"}
    </button>
  );
}

function BrokenTable({ broken }: { broken: BrokenTarget[] }) {
  const [filter, setFilter] = useState<"all" | "4xx" | "5xx">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const rows = filter === "all" ? broken : broken.filter((b) => b.class === filter);
  return (
    <Card
      title="Broken internal links"
      actions={
        <div className="segmented" role="group" aria-label="Status class">
          {(["all", "4xx", "5xx"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all"
                ? `All (${broken.length})`
                : `${f} (${broken.filter((b) => b.class === f).length})`}
            </button>
          ))}
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="No broken internal links">
          Every checked link target answered below 400.
        </EmptyState>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Target</th>
                <th className="num">Links</th>
                <th>Linked from</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((b) => (
                <Fragment key={b.url}>
                  <tr>
                    <td>
                      <Status status={b.finalStatus} />
                    </td>
                    <td>
                      <UrlLink url={b.url} />
                      {b.hops > 0 && (
                        <div className="field-hint">
                          after {b.hops} redirect{b.hops === 1 ? "" : "s"} to{" "}
                          {b.finalUrl === null ? "—" : shortUrl(b.finalUrl)}
                        </div>
                      )}
                    </td>
                    <td className="num">{fmtInt(b.links)}</td>
                    <td>
                      <ExpandButton
                        open={open === b.url}
                        n={b.sources.length}
                        onClick={() => setOpen(open === b.url ? null : b.url)}
                      />
                    </td>
                  </tr>
                  {open === b.url && (
                    <tr className="explain-row">
                      <td colSpan={4}>
                        <Sources sources={b.sources} />
                        {b.hops > 0 && <Chain t={b} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > shown && (
        <Button variant="secondary" onClick={() => setShown(shown + PAGE)}>
          Show {Math.min(PAGE, rows.length - shown)} more
        </Button>
      )}
    </Card>
  );
}

function ChainsTable({ chains, minHops }: { chains: RedirectChain[]; minHops: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  return (
    <Card title={`Redirect chains (${minHops}+ hops)`}>
      {chains.length === 0 ? (
        <EmptyState title="No redirect chains">
          No linked URL needs {minHops} or more redirects.
        </EmptyState>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="num">Hops</th>
                <th>Linked URL</th>
                <th>Ends at</th>
                <th className="num">Links</th>
                <th>Linked from</th>
              </tr>
            </thead>
            <tbody>
              {chains.slice(0, shown).map((c) => (
                <Fragment key={c.url}>
                  <tr>
                    <td className="num">{c.hops}</td>
                    <td>
                      <UrlLink url={c.url} />
                    </td>
                    <td>
                      {c.finalUrl === null ? "—" : <UrlLink url={c.finalUrl} />}{" "}
                      <Status status={c.finalStatus} />
                      {c.endsBroken && (
                        <div className="field-hint">{c.error ?? "does not reach a page"}</div>
                      )}
                    </td>
                    <td className="num">{fmtInt(c.links)}</td>
                    <td>
                      <ExpandButton
                        open={open === c.url}
                        n={c.sources.length}
                        onClick={() => setOpen(open === c.url ? null : c.url)}
                      />
                    </td>
                  </tr>
                  {open === c.url && (
                    <tr className="explain-row">
                      <td colSpan={5}>
                        <Chain t={c} />
                        <Sources sources={c.sources} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {chains.length > shown && (
        <Button variant="secondary" onClick={() => setShown(shown + PAGE)}>
          Show {Math.min(PAGE, chains.length - shown)} more
        </Button>
      )}
    </Card>
  );
}

/**
 * Broken internal links (4xx/5xx targets with the pages that link to them) and redirect
 * chains, from the fetches the crawl recorded.
 */
export function LinksTab() {
  const audit = useCurrentAudit();
  const crawled = audit.crawl.status === "completed";
  const health = useLinkHealth(audit.id, crawled);
  if (!crawled) {
    return (
      <Card>
        <EmptyState title="Not ready yet">The link report needs the finished crawl.</EmptyState>
      </Card>
    );
  }
  return (
    <QueryView query={health}>
      {(h) => {
        const s = h.summary;
        return (
          <div className="grid">
            <div className="stats">
              <StatCard
                label="Broken link targets"
                value={fmtInt(s.brokenTargets)}
                hint={`${fmtInt(s.brokenLinks)} links on ${fmtInt(s.brokenSourcePages)} pages`}
              />
              <StatCard
                label={`Redirect chains (${s.minChainHops}+ hops)`}
                value={fmtInt(s.chainTargets)}
                hint={
                  s.chainTargets > 0
                    ? `longest ${s.maxHops} hops · ${fmtInt(s.redirectTargets)} redirected targets`
                    : `${fmtInt(s.redirectTargets)} redirected targets`
                }
              />
              <StatCard
                label="Internal links checked"
                value={`${fmtInt(s.checkedLinks)} of ${fmtInt(s.internalLinks)}`}
                hint={`${fmtInt(s.uncheckedLinks)} not fetched · ${fmtInt(s.failedLinks)} without an answer`}
              />
            </div>
            <p className="field-hint" style={{ margin: 0 }}>
              From the pages and fetches this crawl recorded; nothing is requested again. Links to
              URLs the crawl never fetched (page cap, nofollow) and fetches without an answer
              (robots.txt, network errors) are counted but not judged.
            </p>
            <BrokenTable broken={h.broken} />
            <ChainsTable chains={h.redirectChains} minHops={s.minChainHops} />
          </div>
        );
      }}
    </QueryView>
  );
}
