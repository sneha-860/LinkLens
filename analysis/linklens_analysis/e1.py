"""E1, canonicalisation sensitivity across the corpus: every pair of policies P0–P5 compared on
each site (policy_pairs.csv of a corpus batch export).

A pair is (a, b) with a before b in P0–P5 order, and signed values are b − a. The metrics are
the ones in packages/eval/src/corpus/metrics.ts `PAIR_METRICS`, plus `node_count_ratio`, the
symmetric node-count agreement min(nodes) / max(nodes) derived here.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import pandas as pd

from . import style

POLICIES = list(style.POLICIES)


@dataclass(frozen=True)
class Metric:
    name: str
    label: str
    # "agreement": 1 = the two policies agree (Jaccard, Spearman, ratio);
    # "magnitude": 0 = they agree (absolute depth shift);
    # "signed": 0 = no systematic change (mean depth shift, b − a).
    kind: str

    @property
    def worst(self) -> str:
        return "min" if self.kind == "agreement" else "max-abs"


# The E1 comparisons, in reporting order.
METRICS: list[Metric] = [
    Metric("node_count_ratio", "Node count ratio (min / max)", "agreement"),
    Metric("orphan_jaccard", "Orphan set Jaccard", "agreement"),
    Metric("pagerank_spearman", "PageRank Spearman (shared pages)", "agreement"),
    Metric("mean_depth_shift", "Mean depth shift (row − column)", "signed"),
    Metric("max_abs_depth_shift", "Max |depth shift|", "magnitude"),
    Metric("top_fixes_jaccard", "Top-k fix list Jaccard", "agreement"),
]
BY_NAME = {m.name: m for m in METRICS}

ALL = "all sites"


def pairs_long(pairs: pd.DataFrame) -> pd.DataFrame:
    """policy_pairs.csv rows, plus the derived `node_count_ratio` per site × pair."""
    p = pairs.copy()
    counts = p[p["metric"].isin(["nodes_a", "nodes_b"])].pivot_table(
        index=["batch_id", "site_id", "architecture_class", "run_id", "policy_a", "policy_b", "top_k"],
        columns="metric",
        values="value",
        observed=True,
    )
    if not counts.empty:
        hi = counts[["nodes_a", "nodes_b"]].max(axis=1)
        lo = counts[["nodes_a", "nodes_b"]].min(axis=1)
        ratio = (lo / hi).where(hi > 0).rename("value").reset_index()
        ratio["metric"] = "node_count_ratio"
        p = pd.concat([p, ratio.dropna(subset=["value"])[p.columns]], ignore_index=True)
    return p


def _metric(pairs: pd.DataFrame, metric: str) -> pd.DataFrame:
    return pairs_long(pairs).query("metric == @metric")


def site_means(pairs: pd.DataFrame, metric: str) -> pd.DataFrame:
    """Per site: the metric's mean over the pairs it has (15 unless some are undefined)."""
    m = _metric(pairs, metric)
    return (
        m.groupby(["architecture_class", "site_id"], observed=True)["value"]
        .agg(value="mean", pairs="size")
        .reset_index()
    )


def _worst_pair(m: pd.DataFrame, metric: Metric) -> tuple[str | None, float]:
    """The pair whose median over sites agrees least."""
    med = m.groupby(["policy_a", "policy_b"], observed=True)["value"].median()
    if med.empty:
        return None, np.nan
    key = med.idxmin() if metric.worst == "min" else med.abs().idxmax()
    return f"{key[0]}–{key[1]}", float(med[key])


def class_summary(pairs: pd.DataFrame, metrics: Sequence[str] | None = None) -> pd.DataFrame:
    """Per architecture class (and all sites) × metric: over sites, the median of each site's
    mean across its policy pairs, the quartiles, and the pair that agrees least (median over
    the class's sites).

    Index (architecture_class, metric); columns sites, median, q1, q3, worst_pair, worst_value.
    """
    names = list(metrics) if metrics is not None else [m.name for m in METRICS]
    data = pairs_long(pairs)
    classes = style.ordered_classes(list(data["architecture_class"].unique()))
    rows = []
    for cls in [*classes, ALL]:
        scope = data if cls == ALL else data[data["architecture_class"] == cls]
        for name in names:
            m = scope[scope["metric"] == name]
            per_site = m.groupby("site_id")["value"].mean()
            worst, worst_value = _worst_pair(m, BY_NAME[name]) if name in BY_NAME else (None, np.nan)
            rows.append(
                {
                    "architecture_class": cls,
                    "metric": name,
                    "sites": int(per_site.size),
                    "median": per_site.median() if per_site.size else np.nan,
                    "q1": per_site.quantile(0.25) if per_site.size else np.nan,
                    "q3": per_site.quantile(0.75) if per_site.size else np.nan,
                    "worst_pair": worst,
                    "worst_value": worst_value,
                }
            )
    return pd.DataFrame(rows).set_index(["architecture_class", "metric"])


def summary_wide(summary: pd.DataFrame) -> pd.DataFrame:
    """The class summary as one row per class, one "median [q1, q3]" column per metric."""
    cell = summary.apply(
        lambda r: "n/a"
        if pd.isna(r["median"])
        else f"{r['median']:.3g} [{r['q1']:.3g}, {r['q3']:.3g}]",
        axis=1,
    )
    out = cell.unstack("metric")
    out = out[[m for m in summary.index.get_level_values("metric").unique()]]
    out.insert(0, "sites", summary["sites"].groupby(level=0).max())
    out.columns.name = None
    return out.reindex(summary.index.get_level_values("architecture_class").unique())


def agreement_matrix(
    pairs: pd.DataFrame,
    metric: str,
    architecture_class: str | None = None,
    stat: str = "median",
) -> pd.DataFrame:
    """The policy × policy matrix of `metric` (median, or mean, over sites).

    Lower triangle only: rows P1–P5, columns P0–P4, cell (row, column) = the pair (column, row),
    so a signed value is row − column. Cells above the diagonal and undefined pairs are NaN.
    """
    m = _metric(pairs, metric)
    if architecture_class is not None and architecture_class != ALL:
        m = m[m["architecture_class"] == architecture_class]
    agg = m.groupby(["policy_a", "policy_b"], observed=True)["value"].agg(stat)
    out = pd.DataFrame(np.nan, index=POLICIES[1:], columns=POLICIES[:-1])
    for (a, b), v in agg.items():
        out.loc[b, a] = v
    out.index.name = "later policy"
    out.columns.name = "earlier policy"
    return out


# ---------- figures ----------


def _limits(metric: Metric, matrices: Sequence[pd.DataFrame]) -> tuple[float, float]:
    values = np.concatenate([m.to_numpy().ravel() for m in matrices])
    values = values[~np.isnan(values)]
    if metric.kind == "agreement":
        lo = min(0.0, float(values.min())) if values.size else 0.0
        return lo, 1.0
    top = float(np.abs(values).max()) if values.size else 1.0
    top = top if top > 0 else 1.0
    return (-top, top) if metric.kind == "signed" else (0.0, top)


def plot_agreement(
    matrix: pd.DataFrame,
    metric: str,
    ax,
    limits: tuple[float, float] | None = None,
    title: str | None = None,
    annotate: bool = True,
):
    """One lower-triangular heatmap; every defined cell carries its value, undefined ones "n/a"."""
    from matplotlib.colors import Normalize

    spec = BY_NAME[metric]
    cmap = style.diverging_cmap() if spec.kind == "signed" else style.sequential_cmap()
    lo, hi = limits if limits is not None else _limits(spec, [matrix])
    norm = Normalize(vmin=lo, vmax=hi)
    data = matrix.to_numpy(dtype=float)
    rows, cols = data.shape
    lower = np.tril(np.ones_like(data, dtype=bool))  # row i ≥ column i: the pairs
    masked = np.ma.array(data, mask=~lower | np.isnan(data))
    image = ax.imshow(masked, cmap=cmap, norm=norm, aspect="equal")

    for i in range(rows):
        for j in range(cols):
            if not lower[i, j]:
                continue
            v = data[i, j]
            if np.isnan(v):
                ax.text(j, i, "n/a", ha="center", va="center", fontsize=7, color=style.muted)
            elif annotate:
                fill = cmap(norm(v))
                ax.text(j, i, f"{v:.2f}", ha="center", va="center", fontsize=7, color=style.text_on(fill))
    # A 2px surface gap between cells.
    ax.set_xticks(np.arange(cols + 1) - 0.5, minor=True)
    ax.set_yticks(np.arange(rows + 1) - 0.5, minor=True)
    ax.grid(which="minor", color=style.surface, linewidth=2)
    ax.grid(which="major", visible=False)
    ax.tick_params(which="minor", length=0)
    ax.set_xticks(range(cols), list(matrix.columns))
    ax.set_yticks(range(rows), list(matrix.index))
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.set_title(title if title is not None else spec.label)
    return image


def agreement_figure(
    pairs: pd.DataFrame,
    metric: str,
    stat: str = "median",
    classes: Sequence[str] | None = None,
):
    """Small multiples: one heatmap per architecture class and one for all sites, on one shared
    colour scale, with a colour bar."""
    import matplotlib.pyplot as plt

    spec = BY_NAME[metric]
    present = style.ordered_classes(list(pairs["architecture_class"].unique()))
    panels = [*(classes if classes is not None else present), ALL]
    matrices = [agreement_matrix(pairs, metric, c, stat) for c in panels]
    limits = _limits(spec, matrices)
    fig, axes = plt.subplots(
        1, len(panels), figsize=(style.DOUBLE_COLUMN, 2.35), squeeze=False
    )
    image = None
    for ax, cls, m in zip(axes[0], panels, matrices):
        n = pairs.loc[
            pairs["architecture_class"].eq(cls) if cls != ALL else slice(None), "site_id"
        ].nunique()
        label = "All sites" if cls == ALL else style.class_label(cls, short=True)
        image = plot_agreement(m, metric, ax, limits, title=f"{label} (n = {n})")
        ax.title.set_fontsize(9)
    for ax in axes[0][1:]:
        ax.set_yticklabels([])
    bar = fig.colorbar(image, ax=list(axes[0]), shrink=0.8, pad=0.02)
    bar.outline.set_visible(False)
    bar.ax.tick_params(labelsize=7.5, length=0)
    bar.set_label(f"{stat} over sites", fontsize=8, color=style.ink_secondary)
    fig.suptitle(spec.label, x=0.01, ha="left", fontsize=11, fontweight="semibold", color=style.ink)
    return fig


def figures(
    pairs: pd.DataFrame, out_dir: str | Path, metrics: Sequence[str] | None = None, stat: str = "median"
) -> list[Path]:
    """One small-multiples heatmap per metric (PDF + PNG), in the shared style."""
    import matplotlib.pyplot as plt

    names = list(metrics) if metrics is not None else [m.name for m in METRICS]
    present = set(pairs_long(pairs)["metric"].unique())
    written: list[Path] = []
    with style.style():
        for name in names:
            if name not in present:
                continue
            fig = agreement_figure(pairs, name, stat)
            written += style.save(fig, Path(out_dir) / f"e1_{name}")
            plt.close(fig)
    return written


def report(directory: str | Path) -> str:
    """Markdown: the per-class summary, then each metric's all-sites matrix."""
    from .corpus import load_batch

    batch = load_batch(directory)
    summary = class_summary(batch.pairs)
    parts = [
        f"## E1 policy sensitivity, batch {batch.batch_id}",
        "",
        "Per class: median over sites of each site's mean across the 15 policy pairs [quartiles].",
        "",
        summary_wide(summary).to_markdown(),
        "",
        "### Least-agreeing pair per class (median over the class's sites)",
        "",
        summary[["worst_pair", "worst_value"]].unstack("metric").to_markdown(floatfmt=".3g"),
    ]
    for m in METRICS:
        mat = agreement_matrix(batch.pairs, m.name)
        if mat.notna().any().any():
            parts += ["", f"### {m.label}: all sites (median)", "", mat.to_markdown(floatfmt=".3g")]
    return "\n".join(parts) + "\n"
