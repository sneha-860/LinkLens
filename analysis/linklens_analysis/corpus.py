"""The corpus batch export (`pnpm --filter @linklens/eval corpus export --batch <name>`):
tidy CSVs, one row per site × policy × metric, compared across architecture classes.

Columns are the contract with packages/eval/src/corpus/csv.ts (checked on load).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
import pandas as pd
from scipy import stats

from . import style

METRICS_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_id",
    "policy",
    "policy_version",
    "is_audit_policy",
    "metric",
    "value",
]
CHANNELS_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_id",
    "policy",
    "policy_version",
    "channel",
    "metric",
    "value",
]
E3_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_id",
    "policy",
    "policy_version",
    "k",
    "method",
    "metric",
    "value",
]
E4_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_a",
    "run_b",
    "comparison",
    "metric",
    "value",
]
E4_PAGES_COLUMNS = ["batch_id", "site_id", "architecture_class", "node", "status", "cause", "reason"]
E5_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_id",
    "policy",
    "policy_version",
    "metric",
    "value",
]
E5_CATEGORIES_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "policy",
    "kind",
    "category",
    "count",
    "share",
    "large",
    "explanation",
    "examples",
]
E5_DISAGREEMENTS_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "policy",
    "kind",
    "node",
    "category",
    "detail",
]
E6_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_id",
    "policy",
    "repeat",
    "seed",
    "method",
    "metric",
    "value",
]
E7_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_id",
    "policy",
    "sigma",
    "epsilon",
    "alpha",
    "scoring",
    "is_default",
    "sweeps",
    "metric",
    "value",
]
E7_SIGMA_PAIRS_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_id",
    "sigma_a",
    "sigma_b",
    "k",
    "jaccard",
]
POLICY_PAIRS_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_id",
    "policy_a",
    "policy_b",
    "top_k",
    "metric",
    "value",
]
SITES_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "url",
    "notes",
    "status",
    "run_id",
    "attempts",
    "audit_policy",
    "pages_fetched",
    "fetches",
    "started_at",
    "finished_at",
    "duration_s",
    "commit",
    "model_sha256",
    "error",
]
STAGES_COLUMNS = [
    "batch_id",
    "site_id",
    "architecture_class",
    "run_id",
    "stage",
    "position",
    "status",
    "duration_ms",
]

# Headline metrics for the class comparison (all exist for every completed site).
DEFAULT_METRICS = [
    "graph.crawled_pages",
    "graph.edges_per_crawled_page",
    "graph.reachable_share",
    "graph.mean_depth",
    "graph.max_depth",
    "graph.largest_scc_share",
    "graph.pagerank_gini",
    "discovery.orphans",
    "discovery.orphan_share",
    "audit.nodes_with_issues_share",
    "diagnosis.v4_share",
    "diagnosis.v3_share",
    "diagnosis.v1_share",
]


@dataclass(frozen=True)
class Batch:
    metrics: pd.DataFrame
    # E1: site × pair of policies × metric (see e1.py).
    pairs: pd.DataFrame
    # E2: site × discovery channel × metric (see e2.py).
    channels: pd.DataFrame
    # E3: site × k × method × metric (see e3.py).
    e3: pd.DataFrame
    # E4: site × comparison × metric, and every page's class (see e4.py; empty before a re-crawl).
    e4: pd.DataFrame
    e4_pages: pd.DataFrame
    # E5: site × policy × metric, the explained categories, every disagreement (see e5.py).
    e5: pd.DataFrame
    e5_categories: pd.DataFrame
    e5_disagreements: pd.DataFrame
    # E6: site × repeat × method × metric (see e6.py).
    e6: pd.DataFrame
    # E7: site × setting × metric, and the σ pairs' top-k overlap (see e7.py).
    e7: pd.DataFrame
    e7_pairs: pd.DataFrame
    sites: pd.DataFrame
    stages: pd.DataFrame

    @property
    def batch_id(self) -> str:
        ids = self.sites["batch_id"].unique()
        return str(ids[0]) if len(ids) == 1 else ",".join(map(str, ids))


def _read(path: Path, columns: list[str]) -> pd.DataFrame:
    df = pd.read_csv(path, dtype={"site_id": str, "architecture_class": str}, keep_default_na=False,
                     na_values=[""])
    if list(df.columns) != columns:
        raise ValueError(f"{path}: expected columns {columns}, got {list(df.columns)}")
    return df


def _read_e7(path: Path) -> pd.DataFrame:
    """e7.csv; an export from before the scoring sweep (L12) has no `scoring` column: all S."""
    legacy = [c for c in E7_COLUMNS if c != "scoring"]
    head = pd.read_csv(path, nrows=0)
    if list(head.columns) == legacy:
        df = _read(path, legacy)
        df.insert(legacy.index("alpha") + 1, "scoring", "S")
        return df
    df = _read(path, E7_COLUMNS)
    df["scoring"] = df["scoring"].fillna("S")
    return df


def load_batch(directory: str | Path) -> Batch:
    """Every CSV of a batch export (metrics, policy_pairs, channels, e3, e4, e4_pages, e5,
    e5_categories, e5_disagreements, e6, e7, e7_sigma_pairs, sites, stages)."""
    d = Path(directory)
    metrics = _read(d / "metrics.csv", METRICS_COLUMNS)
    metrics["value"] = metrics["value"].astype(float)
    metrics["is_audit_policy"] = metrics["is_audit_policy"].astype(int).astype(bool)
    metrics["policy"] = pd.Categorical(metrics["policy"], categories=style.POLICIES, ordered=True)
    if metrics.duplicated(["site_id", "policy", "metric"]).any():
        raise ValueError(f"{d}: a site × policy × metric appears twice")
    pairs = _read(d / "policy_pairs.csv", POLICY_PAIRS_COLUMNS)
    pairs["value"] = pairs["value"].astype(float)
    for c in ("policy_a", "policy_b"):
        pairs[c] = pd.Categorical(pairs[c], categories=style.POLICIES, ordered=True)
    if (pairs["policy_a"].cat.codes >= pairs["policy_b"].cat.codes).any():
        raise ValueError(f"{d}: policy_pairs.csv has a pair not in P0–P5 order")
    if pairs.duplicated(["site_id", "policy_a", "policy_b", "metric"]).any():
        raise ValueError(f"{d}: a site × policy pair × metric appears twice")
    channels = _read(d / "channels.csv", CHANNELS_COLUMNS)
    channels["value"] = channels["value"].astype(float)
    unknown = set(channels["channel"]) - set(style.CHANNELS) - {"all"}
    if unknown:
        raise ValueError(f"{d}: channels.csv has unknown channels {sorted(unknown)}")
    if channels.duplicated(["site_id", "channel", "metric"]).any():
        raise ValueError(f"{d}: a site × channel × metric appears twice")
    e3 = _read(d / "e3.csv", E3_COLUMNS)
    e3["value"] = e3["value"].astype(float)
    unknown_methods = set(e3["method"]) - {"linklens", "random", "highestCosine", "highestPagerank", "site"}
    if unknown_methods:
        raise ValueError(f"{d}: e3.csv has unknown methods {sorted(unknown_methods)}")
    if e3.duplicated(["site_id", "k", "method", "metric"]).any():
        raise ValueError(f"{d}: a site × k × method × metric appears twice")
    e4 = _read(d / "e4.csv", E4_COLUMNS)
    e4["value"] = e4["value"].astype(float)
    if e4.duplicated(["site_id", "comparison", "metric"]).any():
        raise ValueError(f"{d}: a site × comparison × metric appears twice")
    e4_pages = _read(d / "e4_pages.csv", E4_PAGES_COLUMNS)
    e5 = _read(d / "e5.csv", E5_COLUMNS)
    e5["value"] = e5["value"].astype(float)
    if e5.duplicated(["site_id", "policy", "metric"]).any():
        raise ValueError(f"{d}: a site × policy × metric appears twice in e5.csv")
    e5_categories = _read(d / "e5_categories.csv", E5_CATEGORIES_COLUMNS)
    e5_categories["large"] = e5_categories["large"].astype(int).astype(bool)
    e5_disagreements = _read(d / "e5_disagreements.csv", E5_DISAGREEMENTS_COLUMNS)
    e6 = _read(d / "e6.csv", E6_COLUMNS)
    e6["value"] = e6["value"].astype(float)
    if e6.duplicated(["site_id", "repeat", "method", "metric"]).any():
        raise ValueError(f"{d}: a site × repeat × method × metric appears twice in e6.csv")
    e7 = _read_e7(d / "e7.csv")
    e7["value"] = e7["value"].astype(float)
    e7["sweeps"] = e7["sweeps"].astype(str)
    e7["is_default"] = e7["is_default"].astype(int).astype(bool)
    if e7.duplicated(["site_id", "sigma", "epsilon", "alpha", "scoring", "metric"]).any():
        raise ValueError(f"{d}: a site × setting × metric appears twice in e7.csv")
    e7_pairs = _read(d / "e7_sigma_pairs.csv", E7_SIGMA_PAIRS_COLUMNS)
    sites = _read(d / "sites.csv", SITES_COLUMNS)
    stages = _read(d / "stages.csv", STAGES_COLUMNS)
    return Batch(
        metrics=metrics,
        pairs=pairs,
        channels=channels,
        e3=e3,
        e4=e4,
        e4_pages=e4_pages,
        e5=e5,
        e5_categories=e5_categories,
        e5_disagreements=e5_disagreements,
        e6=e6,
        e7=e7,
        e7_pairs=e7_pairs,
        sites=sites,
        stages=stages,
    )


def wide(metrics: pd.DataFrame, policy: str = "P3", names: Iterable[str] | None = None) -> pd.DataFrame:
    """One row per site (index: architecture_class, site_id), one column per metric."""
    m = metrics[metrics["policy"] == policy]
    if names is not None:
        m = m[m["metric"].isin(list(names))]
    out = m.pivot_table(
        index=["architecture_class", "site_id"], columns="metric", values="value", observed=True
    )
    out.columns.name = None
    return out


def class_summary(metrics: pd.DataFrame, metric: str, policy: str = "P3") -> pd.DataFrame:
    """Per class: sites, median, quartiles, mean."""
    m = metrics[(metrics["policy"] == policy) & (metrics["metric"] == metric)]
    g = m.groupby("architecture_class")["value"]
    out = pd.DataFrame(
        {
            "sites": g.size(),
            "median": g.median(),
            "q1": g.quantile(0.25),
            "q3": g.quantile(0.75),
            "mean": g.mean(),
        }
    )
    return out.reindex(style.ordered_classes(list(out.index)))


def holm(p: Sequence[float]) -> np.ndarray:
    """Holm–Bonferroni adjusted p-values (NaN stays NaN)."""
    p = np.asarray(p, dtype=float)
    out = np.full_like(p, np.nan)
    ok = ~np.isnan(p)
    idx = np.where(ok)[0]
    order = idx[np.argsort(p[idx], kind="stable")]
    m = len(order)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p[i]))
        out[i] = running
    return out


def compare_classes(
    metrics: pd.DataFrame, policy: str = "P3", names: Sequence[str] | None = None
) -> pd.DataFrame:
    """Kruskal–Wallis test of each metric across the architecture classes.

    `epsilon_sq` is the rank effect size ε² = H / (n − 1); `p_holm` corrects for testing
    several metrics. A metric with fewer than two classes of data, or no variation, gets NaN.
    """
    names = list(names) if names is not None else DEFAULT_METRICS
    rows = []
    for name in names:
        m = metrics[(metrics["policy"] == policy) & (metrics["metric"] == name)]
        groups = [g["value"].to_numpy() for _, g in m.groupby("architecture_class") if len(g) > 0]
        n = int(sum(len(g) for g in groups))
        h = p = eps = np.nan
        if len(groups) >= 2 and np.unique(np.concatenate(groups)).size > 1:
            h, p = stats.kruskal(*groups)
            eps = h / (n - 1)
        rows.append({"metric": name, "sites": n, "classes": len(groups), "H": h, "p": p, "epsilon_sq": eps})
    out = pd.DataFrame(rows).set_index("metric")
    out["p_holm"] = holm(out["p"].to_numpy())
    return out


def policy_effect(metrics: pd.DataFrame, metric: str) -> dict[str, float]:
    """Friedman test: does `metric` change across P0–P5 within sites (sites as blocks)?"""
    m = metrics[metrics["metric"] == metric].pivot_table(
        index="site_id", columns="policy", values="value", observed=True
    )
    m = m.dropna()
    if m.shape[0] < 2 or m.shape[1] < 3 or np.allclose(m.to_numpy(), m.to_numpy()[:, :1]):
        return {"sites": float(m.shape[0]), "statistic": np.nan, "p": np.nan}
    s, p = stats.friedmanchisquare(*[m[c].to_numpy() for c in m.columns])
    return {"sites": float(m.shape[0]), "statistic": float(s), "p": float(p)}


# ---------- figures ----------


def plot_by_class(metrics: pd.DataFrame, metric: str, policy: str = "P3", ax=None, seed: int = 0):
    """One column per class: every site as a point (jittered, seeded), the median as a bar."""
    import matplotlib.pyplot as plt

    if ax is None:
        _, ax = plt.subplots(figsize=(style.SINGLE_COLUMN, 2.6))
    m = metrics[(metrics["policy"] == policy) & (metrics["metric"] == metric)]
    classes = style.ordered_classes(list(m["architecture_class"].unique()))
    rng = np.random.default_rng(seed)
    for i, cls in enumerate(classes):
        v = m.loc[m["architecture_class"] == cls, "value"].to_numpy()
        x = i + rng.uniform(-0.14, 0.14, size=v.size)
        ax.scatter(
            x,
            v,
            s=30,
            color=style.class_colour(cls),
            marker=style.CLASS_MARKERS.get(cls, "o"),
            edgecolors=style.surface,
            linewidths=1.2,
            zorder=3,
        )
        if v.size:
            # The median sits behind the points, so no site is hidden.
            ax.hlines(np.median(v), i - 0.3, i + 0.3, color=style.ink_secondary, linewidth=1.5, zorder=2)
    ax.set_xticks(range(len(classes)), [style.class_label(c, short=True) for c in classes])
    ax.set_xlim(-0.6, len(classes) - 0.4)
    ax.set_title(metric)
    ax.set_ylabel(f"{metric} ({policy})")
    return ax


def plot_across_policies(metrics: pd.DataFrame, metric: str, ax=None):
    """Median of `metric` per class across P0–P5 (one line per class, direct-labelled)."""
    import matplotlib.pyplot as plt

    if ax is None:
        _, ax = plt.subplots(figsize=(style.SINGLE_COLUMN, 2.6))
    m = metrics[metrics["metric"] == metric]
    med = m.groupby(["architecture_class", "policy"], observed=True)["value"].median().unstack("policy")
    med = med.reindex(columns=[p for p in style.POLICIES if p in med.columns])
    xs = np.arange(med.shape[1])
    for cls in style.ordered_classes(list(med.index)):
        y = med.loc[cls].to_numpy(dtype=float)
        ax.plot(
            xs,
            y,
            color=style.class_colour(cls),
            marker=style.CLASS_MARKERS.get(cls, "o"),
            markersize=5,
            markeredgecolor=style.surface,
            label=style.class_label(cls),
        )
    ax.set_xticks(xs, list(med.columns))
    ax.set_title(metric)
    ax.set_xlabel("canonicalisation policy")
    ax.set_ylabel(f"median {metric}")
    ax.legend(loc="best")
    return ax


def figures(batch: Batch, out_dir: str | Path, names: Sequence[str] | None = None, policy: str = "P3") -> list[Path]:
    """Every default figure of a batch, as PDF and PNG, in the shared style."""
    import matplotlib.pyplot as plt

    names = list(names) if names is not None else DEFAULT_METRICS
    present = set(batch.metrics["metric"].unique())
    written: list[Path] = []
    with style.style():
        for name in names:
            if name not in present:
                continue
            safe = name.replace(".", "_")
            fig, ax = plt.subplots(figsize=(style.SINGLE_COLUMN, 2.6))
            plot_by_class(batch.metrics, name, policy, ax=ax)
            written += style.save(fig, Path(out_dir) / f"by_class_{safe}")
            plt.close(fig)
            fig, ax = plt.subplots(figsize=(style.SINGLE_COLUMN, 2.6))
            plot_across_policies(batch.metrics, name, ax=ax)
            written += style.save(fig, Path(out_dir) / f"policies_{safe}")
            plt.close(fig)
    return written


def report(directory: str | Path, policy: str = "P3") -> str:
    """Markdown: the batch's sites per class and status, then the class comparison."""
    batch = load_batch(directory)
    s = batch.sites
    counts = (
        s.groupby(["architecture_class", "status"]).size().unstack(fill_value=0)
        .reindex(style.ordered_classes(list(s["architecture_class"].unique())))
    )
    present = set(batch.metrics["metric"].unique())
    cmp = compare_classes(batch.metrics, policy, [m for m in DEFAULT_METRICS if m in present])
    parts = [
        f"## Corpus batch {batch.batch_id}",
        "",
        "### Sites by class and status",
        "",
        counts.to_markdown(),
        "",
        f"### Architecture classes compared ({policy}; Kruskal–Wallis, Holm-corrected)",
        "",
        cmp.to_markdown(floatfmt=".4g"),
    ]
    return "\n".join(parts) + "\n"
