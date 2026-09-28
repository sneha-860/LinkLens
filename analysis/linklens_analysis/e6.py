"""E6, link-masking recovery across the corpus (e6.csv of a corpus batch export), and the
refutation test for contribution C5: does the hybrid σ (REF-gated cosine) recover masked
editorial links better than cosine alone?

Per site and repeat, 10–20% of the editorial body links were masked (links and anchor text
removed, REF and embeddings rebuilt; packages/eval/src/e6-masking.ts) and every method ranked
the candidate donors of each masked target. A site's value is the mean over its repeats; sites
are the unit of the paired tests.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

import numpy as np
import pandas as pd
from scipy import stats

from . import RANDOM_SEED, style
from .corpus import holm
from .e3 import rank_biserial

ALL = "all sites"
METHODS = [
    "refGateCosine",
    "cosine",
    "ref",
    "blended",
    "jaccard",
    "commonNeighbours",
    "adamicAdar",
    "random",
]
METHOD_LABELS = {
    "refGateCosine": "Hybrid (REF-gated cosine)",
    "cosine": "Cosine",
    "ref": "REF",
    "blended": "Blended (λ·REF + (1−λ)·cos)",
    "jaccard": "Jaccard",
    "commonNeighbours": "Common Neighbours",
    "adamicAdar": "Adamic–Adar",
    "random": "Random",
}
HYBRID, COSINE = "refGateCosine", "cosine"
# C5's primary metric first; the others are secondary (Holm over all three).
C5_METRICS = ["mrr", "recall@10", "auc"]


def site_means(e6: pd.DataFrame) -> pd.DataFrame:
    """One row per site × method (index: architecture_class, site_id, method), one column per
    metric: the mean over the site's repeats."""
    m = e6[e6["method"] != "masking"]
    out = m.pivot_table(
        index=["architecture_class", "site_id", "method"], columns="metric", values="value", aggfunc="mean", observed=True
    )
    out.columns.name = None
    return out


def masking_summary(e6: pd.DataFrame) -> pd.DataFrame:
    """Per site: repeats, mean share masked, eligible pairs, masked links and queries."""
    m = e6[e6["method"] == "masking"].pivot_table(
        index=["architecture_class", "site_id", "repeat"], columns="metric", values="value", observed=True
    )
    g = m.groupby(level=["architecture_class", "site_id"])
    return pd.DataFrame(
        {
            "repeats": g.size(),
            "share": g["share"].mean(),
            "eligible_pairs": g["eligible_pairs"].mean(),
            "masked": g["masked"].mean(),
            "queries": g["queries"].mean(),
        }
    )


def _metrics(e6: pd.DataFrame) -> list[str]:
    names = set(e6.loc[e6["method"] != "masking", "metric"])
    recalls = sorted((n for n in names if n.startswith("recall@")), key=lambda n: int(n.split("@")[1]))
    return ["mrr", *recalls, *(["auc"] if "auc" in names else [])]


def _mean_ci(values: np.ndarray, n: int = 2000, level: float = 0.95) -> str:
    v = values[~np.isnan(values)]
    if v.size == 0:
        return "n/a"
    if v.size == 1:
        return f"{v[0]:.3f}"
    rng = np.random.default_rng(RANDOM_SEED)
    boots = rng.choice(v, size=(n, v.size), replace=True).mean(axis=1)
    lo, hi = np.quantile(boots, [(1 - level) / 2, 1 - (1 - level) / 2])
    return f"{v.mean():.3f} [{lo:.3f}, {hi:.3f}]"


def results_table(e6: pd.DataFrame) -> pd.DataFrame:
    """The E6 results: per class (then all sites) × method, each metric's mean over sites with a
    seeded bootstrap 95% CI."""
    means = site_means(e6)
    metrics = _metrics(e6)
    classes = style.ordered_classes(list(means.index.get_level_values("architecture_class").unique()))
    present = [m for m in METHODS if m in set(means.index.get_level_values("method"))]
    rows = []
    for cls in [*classes, ALL]:
        scope = means if cls == ALL else means.xs(cls, level="architecture_class", drop_level=False)
        for method in present:
            s = scope.xs(method, level="method")
            row: dict[str, object] = {
                "class": "All sites" if cls == ALL else style.class_label(cls),
                "method": METHOD_LABELS.get(method, method),
                "sites": len(s),
            }
            for metric in metrics:
                row[metric.upper() if metric in ("mrr", "auc") else metric.replace("recall@", "R@")] = (
                    _mean_ci(s[metric].to_numpy(dtype=float)) if metric in s else "n/a"
                )
            rows.append(row)
    return pd.DataFrame(rows).set_index(["class", "method"])


def paired_test(
    e6: pd.DataFrame,
    a: str = HYBRID,
    b: str = COSINE,
    metrics: Sequence[str] = C5_METRICS,
    scope: str | None = None,
) -> pd.DataFrame:
    """`a` vs `b` across sites (one class, or all), per metric: Wilcoxon signed-rank, one-sided
    (a > b) and two-sided, zero differences dropped; the matched-pairs rank-biserial r; mean and
    median difference; wins/ties/losses. `p_holm` is the one-sided p, Holm over the metrics."""
    means = site_means(e6)
    if scope is not None and scope != ALL:
        means = means.xs(scope, level="architecture_class", drop_level=False)
    rows = []
    for metric in metrics:
        if metric not in means:
            continue
        x = means.xs(a, level="method")[metric]
        y = means.xs(b, level="method")[metric]
        both = pd.concat([x.rename("a"), y.rename("b")], axis=1).dropna()
        d = (both["a"] - both["b"]).to_numpy()
        nonzero = d[d != 0]
        p_greater = p_two = w = np.nan
        if nonzero.size >= 1:
            p_greater = float(stats.wilcoxon(nonzero, alternative="greater").pvalue)
            two = stats.wilcoxon(nonzero, alternative="two-sided")
            p_two, w = float(two.pvalue), float(two.statistic)
        rows.append(
            {
                "metric": metric,
                "sites": int(d.size),
                "mean a": float(both["a"].mean()) if d.size else np.nan,
                "mean b": float(both["b"].mean()) if d.size else np.nan,
                "mean difference": float(d.mean()) if d.size else np.nan,
                "median difference": float(np.median(d)) if d.size else np.nan,
                "wins/ties/losses": f"{int((d > 0).sum())}/{int((d == 0).sum())}/{int((d < 0).sum())}",
                "W": w,
                "p (a > b)": p_greater,
                "p (two-sided)": p_two,
                "r (rank-biserial)": rank_biserial(d),
            }
        )
    out = pd.DataFrame(rows).set_index("metric")
    if not out.empty:
        out["p_holm (a > b)"] = holm(out["p (a > b)"].to_numpy())
        out["p_holm (two-sided)"] = holm(out["p (two-sided)"].to_numpy())
    return out


def c5_verdict(test: pd.DataFrame, alpha: float = 0.05, primary: str = "mrr") -> str:
    """The refutation test's outcome on the primary metric (C5: the hybrid beats cosine)."""
    if primary not in test.index or np.isnan(test.loc[primary, "p (a > b)"]):
        return "C5 cannot be tested: no site with a difference between the hybrid and cosine."
    r = test.loc[primary]
    detail = (
        f"{primary.upper()}: mean difference {r['mean difference']:+.3f}, r = {r['r (rank-biserial)']:+.2f}, "
        f"n = {int(r['sites'])} sites"
    )
    if r["p_holm (a > b)"] < alpha:
        return f"C5 supported: the hybrid recovers masked links better than cosine (one-sided Holm p = {r['p_holm (a > b)']:.3g} < {alpha}; {detail})."
    if r["p_holm (two-sided)"] < alpha and r["mean difference"] < 0:
        return f"C5 refuted: cosine alone recovers masked links better than the hybrid (two-sided Holm p = {r['p_holm (two-sided)']:.3g} < {alpha}; {detail})."
    return f"C5 not supported: no significant advantage of the hybrid over cosine (one-sided Holm p = {r['p_holm (a > b)']:.3g} ≥ {alpha}; {detail})."


def report(directory: str | Path, alpha: float = 0.05) -> str:
    """Markdown: the masking, the results table, then the C5 paired test (all sites, then each
    class) and its verdict."""
    from .corpus import load_batch

    batch = load_batch(directory)
    if batch.e6.empty:
        return (
            f"## E6 link-masking recovery, batch {batch.batch_id}\n\n"
            "No E6 results yet: `corpus export` computes them for every completed site.\n"
        )
    masking = masking_summary(batch.e6)
    test = paired_test(batch.e6)
    parts = [
        f"## E6 link-masking recovery, batch {batch.batch_id}",
        "",
        f"{len(masking)} sites, {int(masking['repeats'].max())} repeats each; mean share masked "
        f"{100 * masking['share'].mean():.1f}%, {masking['queries'].sum():.0f} queries (masked links) per repeat across all sites.",
        "",
        "### Results (mean over sites, bootstrap 95% CI)",
        "",
        results_table(batch.e6).to_markdown(),
        "",
        "### C5 refutation test: hybrid vs cosine (paired over sites, Wilcoxon signed-rank)",
        "",
        c5_verdict(test, alpha),
        "",
        test.to_markdown(floatfmt=".4g"),
    ]
    classes = style.ordered_classes(list(batch.e6["architecture_class"].unique()))
    for cls in classes:
        t = paired_test(batch.e6, scope=cls)
        parts += ["", f"#### {style.class_label(cls)}", "", t.to_markdown(floatfmt=".4g")]
    return "\n".join(parts) + "\n"


def methods_figure(e6: pd.DataFrame, metric: str = "mrr", n: int = 2000):
    """Each method's recovery (mean over sites, bootstrap 95% CI), best first; the random
    baseline dashed. One series: a single colour."""
    import matplotlib.pyplot as plt

    means = site_means(e6)
    rows = []
    for method in [m for m in METHODS if m in set(means.index.get_level_values("method"))]:
        v = means.xs(method, level="method")[metric].dropna().to_numpy(dtype=float)
        if v.size == 0:
            continue
        boots = np.random.default_rng(RANDOM_SEED).choice(v, size=(n, v.size)).mean(axis=1)
        lo, hi = np.quantile(boots, [0.025, 0.975])
        rows.append((method, v.mean(), lo, hi))
    rows.sort(key=lambda r: r[1])
    fig, ax = plt.subplots(figsize=(style.SINGLE_COLUMN, 0.32 * len(rows) + 0.9))
    y = np.arange(len(rows))
    means_ = np.array([r[1] for r in rows])
    ax.hlines(y, [r[2] for r in rows], [r[3] for r in rows], color=style.SEQUENTIAL[4], linewidth=2)
    ax.scatter(means_, y, s=30, color=style.SEQUENTIAL[9], edgecolors=style.surface, linewidths=0.8, zorder=3)
    for yi, r in zip(y, rows):
        ax.text(r[3], yi, f"  {r[1]:.3f}", va="center", fontsize=7.5, color=style.ink_secondary)
    random = [r for r in rows if r[0] == "random"]
    if random:
        ax.axvline(random[0][1], color=style.muted, linewidth=0.8, linestyle=(0, (3, 3)), zorder=1)
    ax.set_yticks(y, [METHOD_LABELS.get(r[0], r[0]) for r in rows])
    ax.set_xlabel(f"E6 {metric.upper() if metric in ('mrr', 'auc') else metric} (mean over sites, 95% CI)")
    ax.grid(axis="x")
    ax.grid(axis="y", visible=False)
    return fig
