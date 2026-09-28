"""E3, fixes against baselines across the corpus (e3.csv of a corpus batch export).

For each site and k, every method chose k fixes from the same admissible pool (weak-authority
pages and orphans), the k links were applied together and PageRank recomputed; the measure is
the total ΔPR over the site's weak and orphan pages (`total_delta_pr`). The random baseline is
the mean of seeded draws.

LinkLens is compared with each baseline across sites by a paired Wilcoxon signed-rank test
(two-sided; zero differences dropped, as a site where both choose the same fixes says nothing
about which is better). The effect size is the matched-pairs rank-biserial correlation
r = (R+ − R−) / (R+ + R−) over the non-zero differences: +1 when LinkLens wins on every site, −1
when it loses on every site. p-values are Holm-corrected over the baselines within each k.

`measure="relative"` divides each site's total ΔPR by the targets' PageRank before the fixes
(`target_pagerank_before`), a scale-free gain: PageRank sums to 1, so raw ΔPR shrinks with the
size of the site, and the signed ranks would otherwise weight small sites more.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

from . import style
from .corpus import holm

METHODS = ["linklens", "random", "highestCosine", "highestPagerank"]
BASELINES = ["random", "highestCosine", "highestPagerank"]
METHOD_LABELS = {
    "linklens": "LinkLens",
    "random": "Random admissible donor",
    "highestCosine": "Highest cosine",
    "highestPagerank": "Highest PageRank donor",
}
ALL = "all sites"
MEASURES = ("raw", "relative")


def site_totals(e3: pd.DataFrame, measure: str = "raw") -> pd.DataFrame:
    """One row per site × k (index: architecture_class, site_id, k), one column per method:
    the total ΔPR (or, relative, divided by the targets' PageRank before)."""
    if measure not in MEASURES:
        raise ValueError(f"measure must be one of {MEASURES}")
    m = e3[(e3["method"].isin(METHODS)) & (e3["metric"] == "total_delta_pr")]
    wide = m.pivot_table(
        index=["architecture_class", "site_id", "k"], columns="method", values="value", observed=True
    )
    wide = wide.reindex(columns=[c for c in METHODS if c in wide.columns])
    wide.columns.name = None
    if measure == "relative":
        before = e3[(e3["method"] == "site") & (e3["metric"] == "target_pagerank_before")].set_index(
            "site_id"
        )["value"]
        denom = wide.index.get_level_values("site_id").map(before).to_numpy(dtype=float)
        wide = wide.div(np.where(denom > 0, denom, np.nan), axis=0)
    wide.index = wide.index.set_levels(wide.index.levels[2].astype(int), level="k")
    return wide.sort_index()


def rank_biserial(differences: np.ndarray) -> float:
    """Matched-pairs rank-biserial correlation over the non-zero differences (NaN if none)."""
    d = differences[differences != 0]
    if d.size == 0:
        return float("nan")
    ranks = stats.rankdata(np.abs(d))
    plus = ranks[d > 0].sum()
    minus = ranks[d < 0].sum()
    return float((plus - minus) / (plus + minus))


def paired_test(ours: np.ndarray, theirs: np.ndarray) -> dict[str, float]:
    """LinkLens vs one baseline over paired sites: Wilcoxon signed-rank and its effect size."""
    ok = ~(np.isnan(ours) | np.isnan(theirs))
    ours, theirs = ours[ok], theirs[ok]
    d = ours - theirs
    nonzero = d[d != 0]
    w = p = np.nan
    if nonzero.size >= 1:
        res = stats.wilcoxon(nonzero, zero_method="wilcox", alternative="two-sided")
        w, p = float(res.statistic), float(res.pvalue)
    return {
        "sites": int(d.size),
        "nonzero": int(nonzero.size),
        "wins": int((d > 0).sum()),
        "ties": int((d == 0).sum()),
        "losses": int((d < 0).sum()),
        "median LinkLens": float(np.median(ours)) if d.size else np.nan,
        "median baseline": float(np.median(theirs)) if d.size else np.nan,
        "median difference": float(np.median(d)) if d.size else np.nan,
        "W": w,
        "p": p,
        "r (rank-biserial)": rank_biserial(d),
    }


def paired_tests(e3: pd.DataFrame, measure: str = "raw", scope: str | None = None) -> pd.DataFrame:
    """LinkLens vs each baseline, per k, over the sites (of one class, or all).
    Index (k, baseline); `p_holm` corrects over the three baselines within each k."""
    totals = site_totals(e3, measure)
    if scope is not None and scope != ALL:
        totals = totals.xs(scope, level="architecture_class", drop_level=False)
    rows = []
    for k in sorted(totals.index.get_level_values("k").unique()):
        t = totals.xs(k, level="k")
        for b in BASELINES:
            if "linklens" not in t or b not in t:
                continue
            rows.append({"k": k, "baseline": b, **paired_test(t["linklens"].to_numpy(), t[b].to_numpy())})
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    out["p_holm"] = np.nan
    for k, idx in out.groupby("k").groups.items():
        out.loc[idx, "p_holm"] = holm(out.loc[idx, "p"].to_numpy())
    return out.set_index(["k", "baseline"])


def class_table(e3: pd.DataFrame, cls: str, measure: str = "raw") -> pd.DataFrame:
    """One class (or all sites): per k × method, the median total ΔPR over sites with its
    quartiles and, for the baselines, the paired comparison with LinkLens."""
    totals = site_totals(e3, measure)
    if cls != ALL:
        totals = totals.xs(cls, level="architecture_class", drop_level=False)
    tests = paired_tests(e3, measure, cls)
    rows = []
    for k in sorted(totals.index.get_level_values("k").unique()):
        t = totals.xs(k, level="k")
        for m in METHODS:
            if m not in t:
                continue
            v = t[m].dropna()
            row = {
                "k": k,
                "method": METHOD_LABELS[m],
                "sites": int(v.size),
                "median": v.median() if v.size else np.nan,
                "q1": v.quantile(0.25) if v.size else np.nan,
                "q3": v.quantile(0.75) if v.size else np.nan,
                "LinkLens − method (median)": np.nan,
                "wins/ties/losses": "",
                "r": np.nan,
                "p (Holm)": np.nan,
            }
            if m != "linklens" and (k, m) in tests.index:
                x = tests.loc[(k, m)]
                row.update(
                    {
                        "LinkLens − method (median)": x["median difference"],
                        "wins/ties/losses": f"{int(x['wins'])}/{int(x['ties'])}/{int(x['losses'])}",
                        "r": x["r (rank-biserial)"],
                        "p (Holm)": x["p_holm"],
                    }
                )
            rows.append(row)
    return pd.DataFrame(rows).set_index(["k", "method"])


def class_tables(e3: pd.DataFrame, measure: str = "raw") -> dict[str, pd.DataFrame]:
    """class_table for every class, in the fixed class order, then all sites."""
    classes = style.ordered_classes(list(e3["architecture_class"].unique()))
    return {c: class_table(e3, c, measure) for c in [*classes, ALL]}


def report(directory: str | Path, measure: str = "raw") -> str:
    """Markdown: the paired tests over all sites, then one table per class."""
    from .corpus import load_batch

    batch = load_batch(directory)
    unit = "total ΔPR" if measure == "raw" else "total ΔPR / targets' PR before"
    tests = paired_tests(batch.e3, measure)
    shown = tests.rename(index=METHOD_LABELS, level="baseline")
    parts = [
        f"## E3 fixes vs baselines, batch {batch.batch_id} ({unit})",
        "",
        "Top-k fixes of each method applied together; LinkLens vs each baseline across sites, "
        "paired Wilcoxon signed-rank (two-sided, zero differences dropped), rank-biserial r, "
        "Holm over the baselines within each k.",
        "",
        shown.to_markdown(floatfmt=".4g"),
    ]
    for cls, table in class_tables(batch.e3, measure).items():
        label = "All sites" if cls == ALL else style.class_label(cls)
        parts += ["", f"### {label}", "", table.to_markdown(floatfmt=".4g")]
    return "\n".join(parts) + "\n"


def paired_figure(e3: pd.DataFrame, measure: str = "relative"):
    """Per site, LinkLens minus each baseline (one panel per k): points coloured by class, the
    median as a bar, zero dashed. Above zero, LinkLens's top-k gains more ΔPR."""
    import matplotlib.pyplot as plt

    totals = site_totals(e3, measure)
    ks = sorted(totals.index.get_level_values("k").unique())
    fig, axes = plt.subplots(1, len(ks), figsize=(style.DOUBLE_COLUMN, 2.6), sharey=True, squeeze=False)
    rng = np.random.default_rng(0)
    for ax, k in zip(axes[0], ks):
        t = totals.xs(k, level="k")
        for i, b in enumerate(BASELINES):
            if "linklens" not in t or b not in t:
                continue
            d = (t["linklens"] - t[b]).dropna()
            for cls in style.ordered_classes(list(d.index.get_level_values("architecture_class").unique())):
                v = d.xs(cls, level="architecture_class").to_numpy()
                ax.scatter(
                    i + rng.uniform(-0.15, 0.15, v.size),
                    v,
                    s=18,
                    color=style.class_colour(cls),
                    marker=style.CLASS_MARKERS.get(cls, "o"),
                    edgecolors=style.surface,
                    linewidths=0.8,
                    zorder=3,
                    label=style.class_label(cls) if (k == ks[0] and i == 0) else None,
                )
            if len(d):
                ax.hlines(np.median(d), i - 0.3, i + 0.3, color=style.ink_secondary, linewidth=1.5, zorder=2)
        ax.axhline(0, color=style.muted, linewidth=0.8, linestyle=(0, (3, 3)), zorder=1)
        ax.set_xticks(range(len(BASELINES)), ["Random", "Cosine", "PageRank"])
        ax.set_title(f"top-{k}", fontsize=9.5)
    unit = "Δ total ΔPR" if measure == "raw" else "Δ (total ΔPR ÷ targets' PR)"
    axes[0][0].set_ylabel(f"LinkLens − baseline\n{unit}")
    fig.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncols=3, frameon=False)
    return fig
