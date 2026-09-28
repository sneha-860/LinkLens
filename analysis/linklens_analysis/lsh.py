"""The LSH Ensemble REF pre-filter against exact REF, across page caps (lsh.csv of an `lsh run`).

Per site and cap (packages/eval/src/lsh-prefilter.ts): the true pairs (REF > ε, exact), and per
containment threshold the LSH candidates and what they recover:

- recall: true pairs found / true pairs; mass_recall: the same weighted by REF;
- top_recall: recall of each target's top candidateMaxPerTarget donors by REF (what fix
  candidates keep); precision: true pairs / candidates; candidate_share: candidates / all pairs;
- runtimes (ms, median of the repeats): ms_brute_force (every pair with `ref()`, run once),
  ms_exact (interning + the exact inverted index) and ms_lsh_total (interning + hashing +
  MinHash + index + queries + exact scoring of the candidates).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import style

VARIANTS = ["weighted", "unweighted"]
# Runtime lines: the two exact baselines in ink, the pre-filter in the accent (emphasis, not a
# categorical palette); every line also has its own marker and a direct label.
METHODS = {
    "ms_brute_force": ("Brute force (all pairs)", style.ink_secondary, "s"),
    "ms_exact": ("Exact (inverted index)", style.muted, "^"),
    "ms_lsh_total": ("LSH Ensemble + exact scoring", "#2a78d6", "o"),
}
# Thresholds are ordinal: one hue, light → dark (the lightest step has markers and labels).
THRESHOLD_COLOURS = ["#6da7ec", "#2a78d6", "#104281"]
THRESHOLD_MARKERS = ["o", "s", "D"]


def load(directory: str | Path) -> tuple[pd.DataFrame, dict]:
    """lsh.csv (checked) and lsh.json of an `lsh run` output directory."""
    d = Path(directory)
    df = pd.read_csv(d / "lsh.csv", dtype={"site_id": str, "variant": str})
    need = {"site_id", "run_id", "policy_version", "cap", "documents", "variant", "threshold", "metric", "value"}
    missing = need - set(df.columns)
    if missing:
        raise ValueError(f"lsh.csv lacks columns {sorted(missing)}")
    meta = json.loads((d / "lsh.json").read_text(encoding="utf-8")) if (d / "lsh.json").exists() else {}
    return df, meta


def default_threshold(df: pd.DataFrame, meta: dict) -> float:
    """The configured lshThreshold (from lsh.json), else the middle one measured."""
    if "threshold" in meta:
        return float(meta["threshold"])
    ts = sorted(df["threshold"].dropna().unique())
    return float(ts[len(ts) // 2])


def _wide(df: pd.DataFrame, variant: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Per site × cap: shared and per-variant metrics (columns), and per threshold metrics."""
    base = df[df["variant"].isna()].pivot_table(index=["site_id", "cap"], columns="metric", values="value")
    v = df[(df["variant"] == variant) & df["threshold"].isna()].pivot_table(
        index=["site_id", "cap"], columns="metric", values="value"
    )
    t = df[(df["variant"] == variant) & df["threshold"].notna()].pivot_table(
        index=["site_id", "cap", "threshold"], columns="metric", values="value"
    )
    docs = df.groupby(["site_id", "cap"])["documents"].first()
    return base.join(v).join(docs), t


def summary_table(df: pd.DataFrame, threshold: float, variant: str = "weighted") -> pd.DataFrame:
    """One row per site × cap at `threshold`: size, true pairs, candidates, recall, runtimes and
    the speed-up of the pre-filter over brute force and over the exact inverted index."""
    shared, per_t = _wide(df, variant)
    t = per_t.xs(threshold, level="threshold")
    out = pd.DataFrame(index=shared.index)
    out["pages"] = shared["documents"].astype(int)
    out["true pairs"] = shared["true_pairs"].astype(int)
    out["candidates (% of pairs)"] = 100 * t["candidate_share"]
    out["recall"] = t["recall"]
    out["REF-mass recall"] = t["mass_recall"]
    out["top-30 recall"] = t["top_recall"]
    out["precision"] = t["precision"]
    out["brute force (s)"] = shared.get("ms_brute_force", pd.Series(np.nan, index=shared.index)) / 1000
    out["exact (s)"] = shared["ms_exact"] / 1000
    out["LSH (s)"] = t["ms_lsh_total"] / 1000
    out["speed-up vs brute force"] = out["brute force (s)"] / out["LSH (s)"]
    out["speed-up vs exact"] = out["exact (s)"] / out["LSH (s)"]
    out.index = out.index.set_names(["site", "cap"])
    out.attrs["setting"] = f"{variant} REF, containment threshold t* = {threshold:g}"
    return out


def threshold_table(df: pd.DataFrame, variant: str = "weighted") -> pd.DataFrame:
    """Per cap × threshold, the mean over sites of the candidate share, recalls, precision and the
    pre-filter's runtime (the trade-off the threshold controls)."""
    _, per_t = _wide(df, variant)
    cols = {
        "candidate_share": "candidates (share)",
        "recall": "recall",
        "mass_recall": "REF-mass recall",
        "top_recall": "top-30 recall",
        "precision": "precision",
        "ms_lsh_total": "LSH (ms)",
    }
    m = per_t[list(cols)].groupby(level=["cap", "threshold"]).mean().rename(columns=cols)
    m["sites"] = per_t.groupby(level=["cap", "threshold"]).size()
    return m


def _label_ends(ax, x: float, items: list[tuple[float, str]], min_gap_px: float = 11) -> None:
    """Direct labels at the right end of lines, nudged apart vertically so none overlap (lines
    that coincide still get one readable label each)."""
    ax.figure.canvas.draw()
    to_px = ax.transData
    ys = sorted(((to_px.transform((x, y))[1], text) for y, text in items if np.isfinite(y)))
    placed: list[tuple[float, str]] = []
    for y, text in ys:
        if placed and y - placed[-1][0] < min_gap_px:
            y = placed[-1][0] + min_gap_px
        placed.append((y, text))
    # Back to data coordinates (they survive the save's different dpi and tight bounding box).
    x_px = to_px.transform((x, 0))[0]
    back = to_px.inverted()
    for y, text in placed:
        ax.annotate(text, xy=(x, back.transform((x_px, y))[1]), xytext=(7, 0),
                    textcoords="offset points", va="center", fontsize=7.5,
                    color=style.ink_secondary, annotation_clip=False)


def figure(df: pd.DataFrame, threshold: float, variant: str = "weighted"):
    """Two panels: candidate recall against the page cap (one line per threshold, mean over sites,
    sites as faint points); runtime against the page cap on a log scale (brute force, exact and
    the pre-filter at `threshold`)."""
    import matplotlib.pyplot as plt

    shared, per_t = _wide(df, variant)
    caps = sorted(shared.index.get_level_values("cap").unique())
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(style.DOUBLE_COLUMN, 3.4))

    thresholds = sorted(per_t.index.get_level_values("threshold").unique())
    ends1: list[tuple[float, str]] = []
    colours = THRESHOLD_COLOURS if len(thresholds) <= len(THRESHOLD_COLOURS) else None
    for i, t in enumerate(thresholds):
        colour = colours[i] if colours else style.sequential_cmap()(0.35 + 0.6 * i / max(1, len(thresholds) - 1))
        rec = per_t.xs(t, level="threshold")["recall"]
        mean = rec.groupby(level="cap").mean().reindex(caps)
        ax1.scatter(rec.index.get_level_values("cap"), rec, s=10, color=colour, alpha=0.35, linewidths=0, zorder=2)
        ax1.plot(caps, mean, color=colour, marker=THRESHOLD_MARKERS[i % 3], markersize=5,
                 markeredgecolor=style.surface, linewidth=2, zorder=3, label=f"t* = {t:g}")
        ends1.append((float(mean.iloc[-1]), f"t* = {t:g}"))
    ax1.set_xscale("log")
    ax1.set_xticks(caps, [str(c) for c in caps])
    ax1.minorticks_off()
    ax1.set_ylim(min(0.5, ax1.get_ylim()[0]), 1.02)
    ax1.set_xlabel("page cap")
    ax1.set_ylabel(f"candidate recall ({variant} REF > ε)")
    ax1.set_title("Pairs the pre-filter recovers", fontsize=9.5)
    ax1.set_xlim(caps[0] / 1.25, caps[-1] * 1.6)
    ax1.legend(loc="upper center", bbox_to_anchor=(0.5, -0.24), ncols=len(thresholds), frameon=False,
               fontsize=7.5)

    t = per_t.xs(threshold, level="threshold")
    series = {
        "ms_brute_force": shared.get("ms_brute_force"),
        "ms_exact": shared["ms_exact"],
        "ms_lsh_total": t["ms_lsh_total"],
    }
    ends2: list[tuple[float, str]] = []
    for key, values in series.items():
        if values is None or values.dropna().empty:
            continue
        label, colour, marker = METHODS[key]
        s = values / 1000
        mean = s.groupby(level="cap").mean().reindex(caps)
        ax2.scatter(s.index.get_level_values("cap"), s, s=10, color=colour, alpha=0.35, linewidths=0, zorder=2)
        ax2.plot(caps, mean, color=colour, marker=marker, markersize=5, markeredgecolor=style.surface,
                 linewidth=2, zorder=3, label=label)
        ends2.append((float(mean.iloc[-1]), label.split(" (")[0].replace(" + exact scoring", "")))
    ax2.set_xscale("log")
    ax2.set_yscale("log")
    ax2.set_xticks(caps, [str(c) for c in caps])
    ax2.minorticks_off()
    ax2.set_xlabel("page cap")
    ax2.set_ylabel("REF runtime (s, log scale)")
    ax2.set_title(f"Runtime (pre-filter at t* = {threshold:g})", fontsize=9.5)
    ax2.set_xlim(caps[0] / 1.25, caps[-1] * 2.2)
    ax2.legend(loc="upper center", bbox_to_anchor=(0.5, -0.24), ncols=1, frameon=False, fontsize=7.5)
    _label_ends(ax1, caps[-1], ends1)
    _label_ends(ax2, caps[-1], ends2)
    return fig


def figures(directory: str | Path, out_dir: str | Path, variant: str = "weighted") -> list[Path]:
    """The recall/runtime figure (PDF + PNG) in the shared style."""
    import matplotlib.pyplot as plt

    df, meta = load(directory)
    with style.style():
        fig = figure(df, default_threshold(df, meta), variant)
        written = style.save(fig, Path(out_dir) / f"lsh_prefilter_{variant}")
        plt.close(fig)
    return written


def report(directory: str | Path, variant: str = "weighted") -> str:
    """Markdown: the per-site table at the configured threshold, then the threshold trade-off."""
    df, meta = load(directory)
    t = default_threshold(df, meta)
    table = summary_table(df, t, variant)
    parts = [
        "## LSH Ensemble REF pre-filter vs exact REF",
        "",
        f"### Per site and page cap ({table.attrs['setting']})",
        "",
        table.to_markdown(floatfmt=".3g"),
        "",
        "### Containment threshold trade-off (mean over sites)",
        "",
        threshold_table(df, variant).to_markdown(floatfmt=".3g"),
    ]
    if meta:
        p = meta.get("params", {})
        parts += [
            "",
            f"MinHash {p.get('numPerm')} permutations, {p.get('partitions')} partitions, rows ≤ "
            f"{p.get('maxRows')}, ε = {meta.get('epsilon')}, median of {meta.get('repeats')} runs "
            f"(brute force once); host: {meta.get('host', {}).get('cpu')}.",
        ]
    return "\n".join(parts) + "\n"
