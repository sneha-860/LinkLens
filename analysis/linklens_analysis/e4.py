"""E4, re-crawl stability across the corpus (e4.csv of a corpus batch export, written once the
re-crawl wave has run: `pnpm --filter @linklens/eval corpus recrawl`).

Each site was crawled twice, e4RecrawlDays (14) apart. Its pages are classified (unchanged,
changed, or crawled once, with a cause: the site or the crawl), and the audit is compared in
five ways (packages/eval/src/e4-stability.ts):

- observed: the two runs as crawled;
- siteChange: both restricted to the pages both crawled plus the site-caused ones (the crawl's
  coverage noise removed): what differs is the site;
- samePages: both restricted to the unchanged pages and discovery documents (identical inputs):
  what differs is the method's own instability;
- coverageA / coverageB: each run with and without the pages the other run missed for crawl
  reasons: how much coverage noise moves the results.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from . import style

ALL = "all sites"
METRICS = ["node_jaccard", "pagerank_spearman", "orphan_jaccard", "top_fixes_jaccard"]
METRIC_LABELS = {
    "node_jaccard": "Node overlap (Jaccard)",
    "pagerank_spearman": "PageRank Spearman",
    "orphan_jaccard": "Orphan set Jaccard",
    "top_fixes_jaccard": "Top-k fix overlap (Jaccard)",
}
COMPARISONS = ["observed", "siteChange", "samePages", "coverageA", "coverageB"]
COMPARISON_LABELS = {
    "observed": "observed",
    "siteChange": "site change only",
    "samePages": "same pages (method)",
    "coverageA": "crawl coverage, run A",
    "coverageB": "crawl coverage, run B",
}
# Per-site page shares, from the "pages" rows.
PAGE_SHARES = {
    "unchanged": "unchanged",
    "changed": "changed (site)",
    "site": "crawled once: site",
    "method": "crawled once: crawl",
}


def page_shares(e4: pd.DataFrame) -> pd.DataFrame:
    """Per site (index: architecture_class, site_id): days apart and the share of the union of
    pages that is unchanged, changed, crawled once for a site reason, or for a crawl reason."""
    p = e4[e4["comparison"] == "pages"].pivot_table(
        index=["architecture_class", "site_id"], columns="metric", values="value", observed=True
    )
    union = p["union"].where(p["union"] > 0)
    site = p[[c for c in p.columns if c.startswith("site_") and c != "site_change_share"]].sum(axis=1)
    method = p[[c for c in p.columns if c.startswith("method_") and c != "method_share"]].sum(axis=1)
    out = pd.DataFrame(
        {
            "days_apart": p["days_apart"],
            "pages": p["union"],
            "unchanged": p["unchanged"] / union,
            "changed": p["changed"] / union,
            "site": site / union,
            "method": method / union,
        }
    )
    out.columns.name = None
    return out


def comparisons(e4: pd.DataFrame) -> pd.DataFrame:
    """Per site × comparison (index: architecture_class, site_id, comparison), one column per
    metric."""
    c = e4[e4["comparison"].isin(COMPARISONS) & e4["metric"].isin(METRICS)]
    out = c.pivot_table(
        index=["architecture_class", "site_id", "comparison"], columns="metric", values="value", observed=True
    )
    out.columns.name = None
    return out.reindex(columns=[m for m in METRICS if m in out.columns])


def _cell(values: pd.Series) -> str:
    v = values.dropna()
    if v.empty:
        return "n/a"
    return f"{v.median():.3f} [{v.quantile(0.25):.3f}, {v.quantile(0.75):.3f}]"


def summary_table(e4: pd.DataFrame, comparisons_shown: tuple[str, ...] = ("observed", "siteChange", "samePages")) -> pd.DataFrame:
    """The E4 summary: one row per architecture class (then all sites). Columns: sites, median
    days apart, the median page shares, and for each metric × comparison the median over sites
    with its quartiles ("median [q1, q3]")."""
    shares = page_shares(e4)
    comps = comparisons(e4)
    classes = style.ordered_classes(list(shares.index.get_level_values("architecture_class").unique()))
    rows = []
    for cls in [*classes, ALL]:
        s = shares if cls == ALL else shares.xs(cls, level="architecture_class", drop_level=False)
        c = comps if cls == ALL else comps.xs(cls, level="architecture_class", drop_level=False)
        row: dict[str, object] = {
            "class": "All sites" if cls == ALL else style.class_label(cls),
            "sites": len(s),
            "days apart": f"{s['days_apart'].median():.1f}" if len(s) else "n/a",
        }
        for key, label in PAGE_SHARES.items():
            row[f"pages {label}"] = f"{100 * s[key].median():.1f}%" if s[key].notna().any() else "n/a"
        for metric in METRICS:
            for comp in comparisons_shown:
                sub = c.xs(comp, level="comparison") if comp in c.index.get_level_values("comparison") else None
                values = sub[metric] if sub is not None and metric in sub else pd.Series(dtype=float)
                row[f"{METRIC_LABELS[metric]}: {COMPARISON_LABELS[comp]}"] = _cell(values)
        rows.append(row)
    return pd.DataFrame(rows).set_index("class")


def attribution(e4: pd.DataFrame) -> pd.DataFrame:
    """Per class × metric: the median disagreement (1 − agreement) observed, with only the site's
    changes (siteChange), and on identical pages (samePages). What the site explains is the
    siteChange share of the observed disagreement; the rest is the crawl."""
    comps = comparisons(e4)
    classes = style.ordered_classes(list(comps.index.get_level_values("architecture_class").unique()))
    rows = []
    for cls in [*classes, ALL]:
        c = comps if cls == ALL else comps.xs(cls, level="architecture_class", drop_level=False)
        for metric in METRICS:
            med = {
                comp: (1 - c.xs(comp, level="comparison")[metric]).median()
                if comp in c.index.get_level_values("comparison") and metric in c
                else np.nan
                for comp in ("observed", "siteChange", "samePages")
            }
            observed = med["observed"]
            rows.append(
                {
                    "class": "All sites" if cls == ALL else style.class_label(cls),
                    "metric": METRIC_LABELS[metric],
                    "observed disagreement": observed,
                    "site change": med["siteChange"],
                    "method (same pages)": med["samePages"],
                    "site share of observed": med["siteChange"] / observed
                    if observed is not None and observed > 0
                    else np.nan,
                }
            )
    return pd.DataFrame(rows).set_index(["class", "metric"])


def report(directory: str | Path) -> str:
    """Markdown: the summary table, then the attribution of the disagreement."""
    from .corpus import load_batch

    batch = load_batch(directory)
    if batch.e4.empty:
        return (
            f"## E4 re-crawl stability, batch {batch.batch_id}\n\n"
            "No re-crawl compared yet: run `pnpm --filter @linklens/eval corpus recrawl`, then "
            "`corpus export`.\n"
        )
    parts = [
        f"## E4 re-crawl stability, batch {batch.batch_id}",
        "",
        "Medians over sites [quartiles]. Observed: the two crawls as they are. Site change only: "
        "the crawl's coverage noise removed. Same pages: identical pages and documents, so any "
        "difference is the method's.",
        "",
        summary_table(batch.e4).to_markdown(),
        "",
        "### Disagreement (1 − agreement), median over sites",
        "",
        attribution(batch.e4).to_markdown(floatfmt=".3f"),
    ]
    return "\n".join(parts) + "\n"
