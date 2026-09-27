"""E5, calibration against Screaming Frog (e5.csv, e5_categories.csv of a corpus batch export).

For the corpus's 10 Screaming Frog sites, both tools' URLs were mapped through P0 and the
audit's policy (packages/eval/src/e5-screaming-frog.ts) and compared: URL sets, inlink counts
(Spearman, against inlinks recomputed from All Inlinks under the same policy, and against
Screaming Frog's own Unique Inlinks column), crawl depth, and the orphan sets. Every
disagreement has a category with a stated cause; e5_categories.csv holds them per site.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from . import style

ALL = "all sites"
# (column label, metric) of the calibration table.
MEASURES = [
    ("URL Jaccard", "url_jaccard"),
    ("inlinks Spearman", "inlink_spearman"),
    ("inlinks Spearman (SF column)", "inlink_spearman_column"),
    ("depth exact", "depth_exact"),
    ("depth ±1", "depth_within_one"),
    ("depth Spearman", "depth_spearman"),
    ("orphan Jaccard", "orphan_jaccard"),
]
KIND_LABELS = {
    "url-only-screaming-frog": "URL only in Screaming Frog",
    "url-only-linklens": "URL only in LinkLens",
    "depth": "crawl depth",
    "inlinks": "inlink count",
    "orphan-only-screaming-frog": "orphan only in Screaming Frog",
    "orphan-only-linklens": "orphan only in LinkLens",
}


def site_table(e5: pd.DataFrame) -> pd.DataFrame:
    """One row per site × policy (index: architecture_class, site_id, policy), one column per
    metric."""
    w = e5.pivot_table(
        index=["architecture_class", "site_id", "policy"], columns="metric", values="value", observed=True
    )
    w.columns.name = None
    return w


def _cell(values: pd.Series) -> str:
    v = values.dropna()
    if v.empty:
        return "n/a"
    if len(v) == 1:
        return f"{v.iloc[0]:.3f}"
    return f"{v.median():.3f} [{v.quantile(0.25):.3f}, {v.quantile(0.75):.3f}]"


def calibration_table(e5: pd.DataFrame) -> pd.DataFrame:
    """The E5 calibration table: one row per class (then all sites) × policy; each measure is the
    median over the sites [quartiles] (the value itself for one site)."""
    w = site_table(e5)
    classes = style.ordered_classes(list(w.index.get_level_values("architecture_class").unique()))
    policies = sorted(w.index.get_level_values("policy").unique(), key=lambda p: style.POLICIES.index(p))
    rows = []
    for cls in [*classes, ALL]:
        scope = w if cls == ALL else w.xs(cls, level="architecture_class", drop_level=False)
        for policy in policies:
            s = scope.xs(policy, level="policy")
            row: dict[str, object] = {
                "class": "All sites" if cls == ALL else style.class_label(cls),
                "policy": policy,
                "sites": len(s),
                "URLs LinkLens / SF (median)": f"{s['urls_linklens'].median():.0f} / {s['urls_screaming_frog'].median():.0f}"
                if len(s)
                else "n/a",
            }
            for label, metric in MEASURES:
                row[label] = _cell(s[metric]) if metric in s else "n/a"
            rows.append(row)
    return pd.DataFrame(rows).set_index(["class", "policy"])


def large_categories(categories: pd.DataFrame) -> pd.DataFrame:
    """Every category that is large on at least one site, per policy × kind: on how many sites it
    is large, its disagreements pooled over all sites (and their share of the kind), example sites,
    and its explanation (the most common filled text)."""
    if categories.empty:
        return pd.DataFrame(
            columns=["sites large", "count", "share of kind", "example sites", "explanation"]
        )
    totals = categories.groupby(["policy", "kind"])["count"].sum()
    rows = []
    for (policy, kind, category), g in categories.groupby(["policy", "kind", "category"], sort=False):
        large = g[g["large"].astype(bool)]
        if large.empty:
            continue
        count = int(g["count"].sum())
        rows.append(
            {
                "policy": policy,
                "kind": KIND_LABELS.get(kind, kind),
                "category": category,
                "sites large": int(large["site_id"].nunique()),
                "count": count,
                "share of kind": count / totals[(policy, kind)],
                "example sites": ", ".join(sorted(large["site_id"].unique())[:3]),
                "explanation": g["explanation"].value_counts().index[0],
            }
        )
    out = pd.DataFrame(rows)
    order = {p: i for i, p in enumerate(style.POLICIES)}
    out = out.sort_values(
        ["policy", "kind", "count"], key=lambda c: c.map(order) if c.name == "policy" else c, ascending=[True, True, False]
    )
    return out.set_index(["policy", "kind", "category"])


def report(directory: str | Path) -> str:
    """Markdown: the calibration table, then every large disagreement category explained."""
    from .corpus import load_batch

    batch = load_batch(directory)
    if batch.e5.empty:
        return (
            f"## E5 Screaming Frog calibration, batch {batch.batch_id}\n\n"
            "No Screaming Frog exports imported yet: `pnpm --filter @linklens/eval corpus import-sf "
            "--batch <name> --site <id> --from <folder>`, then `corpus export`.\n"
        )
    sites = batch.e5["site_id"].nunique()
    parts = [
        f"## E5 Screaming Frog calibration, batch {batch.batch_id} ({sites} sites)",
        "",
        "Both tools' URLs mapped through each policy. Medians over sites [quartiles]. Inlinks: "
        "Spearman against Screaming Frog's inlinks recomputed from All Inlinks under the same "
        "policy, and against its own Unique Inlinks column.",
        "",
        calibration_table(batch.e5).to_markdown(),
        "",
        "### Large disagreement categories, explained",
        "",
        "A category is large on a site when it holds at least e5LargeShare of that kind's "
        "disagreements and at least e5LargeMin of them (packages/core/src/config.ts).",
        "",
    ]
    large = large_categories(batch.e5_categories)
    if large.empty:
        parts.append("No category is large on any site.")
    else:
        for (policy, kind, category), r in large.iterrows():
            parts += [
                f"- **{policy} · {kind} · {category}** — {r['count']} disagreements "
                f"({100 * r['share of kind']:.0f}% of this kind), large on {r['sites large']} "
                f"site(s) (e.g. {r['example sites']}). {r['explanation']}",
            ]
    return "\n".join(parts) + "\n"
