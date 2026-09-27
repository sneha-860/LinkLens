"""E2, channel ablation across the corpus (channels.csv of a corpus batch export).

For each site, every discovery channel was removed in turn and the reconciliation recomputed
(core `discovery.leaveOneChannelOut`, under the audit's policy). Per channel:

- marginal page yield: inventory pages lost without the channel (`pages_exclusive`);
- marginal orphan yield: orphans lost without it (`orphans_exclusive`), i.e. the orphans only
  it detects, and their share of the site's orphans.

The link graph can never be the only detector of an orphan (an orphan is by definition revealed
by a non-link channel), so its orphan yield is always 0; its page yield is not.
"""

from __future__ import annotations

from pathlib import Path
import numpy as np
import pandas as pd

from . import style

ALL = "all sites"
# The segments of the orphan composition: detected only by one non-link channel, or by several.
ORPHAN_CHANNELS = [c for c in style.CHANNELS if c != "link_graph"]
SEVERAL = "several"


def _wide(channels: pd.DataFrame) -> pd.DataFrame:
    """One row per site × channel, one column per metric."""
    w = channels.pivot_table(
        index=["architecture_class", "site_id", "channel"], columns="metric", values="value", observed=True
    )
    w.columns.name = None
    return w.reset_index()


def site_totals(channels: pd.DataFrame) -> pd.DataFrame:
    """Per site: inventory, orphans and orphans detected by several non-link channels."""
    t = _wide(channels[channels["channel"] == "all"]).drop(columns="channel")
    return t.set_index(["architecture_class", "site_id"])


def _scopes(channels: pd.DataFrame) -> list[tuple[str, pd.DataFrame]]:
    classes = style.ordered_classes(list(channels["architecture_class"].unique()))
    return [(c, channels[channels["architecture_class"] == c]) for c in classes] + [(ALL, channels)]


def class_table(channels: pd.DataFrame) -> pd.DataFrame:
    """Per architecture class (and all sites) × channel.

    - `sites`, `sites_with_orphans`;
    - `pages_exclusive`: pages lost without the channel, summed over sites, and
      `page_yield_share` = that sum / the summed inventory; `pages_exclusive_median` per site;
    - `orphans_total`: orphans the channel detects; `orphans_exclusive`: detected only by it;
    - `orphan_only_share` = Σ orphans_exclusive / Σ orphans (pooled over the class's orphans), and
      `orphan_only_share_median`, the median of the per-site shares (sites with orphans only).
    """
    rows = []
    for scope, data in _scopes(channels):
        totals = site_totals(data)
        per = _wide(data[data["channel"] != "all"])
        inventory = totals["inventory"].sum()
        orphans = totals["orphans"].sum()
        for ch in style.CHANNELS:
            c = per[per["channel"] == ch]
            shares = c["orphans_exclusive_share"].dropna() if "orphans_exclusive_share" in c else c.iloc[0:0]
            rows.append(
                {
                    "architecture_class": scope,
                    "channel": ch,
                    "sites": int(c["site_id"].nunique()),
                    "sites_with_orphans": int((totals["orphans"] > 0).sum()),
                    "pages_exclusive": c["pages_exclusive"].sum(),
                    "page_yield_share": c["pages_exclusive"].sum() / inventory if inventory > 0 else np.nan,
                    "pages_exclusive_median": c["pages_exclusive"].median() if len(c) else np.nan,
                    "orphans_total": c["orphans_total"].sum(),
                    "orphans_exclusive": c["orphans_exclusive"].sum(),
                    "orphan_only_share": c["orphans_exclusive"].sum() / orphans if orphans > 0 else np.nan,
                    "orphan_only_share_median": shares.median() if len(shares) else np.nan,
                }
            )
    return pd.DataFrame(rows).set_index(["architecture_class", "channel"])


def display_table(table: pd.DataFrame) -> pd.DataFrame:
    """The class table for reading: one row per class × channel, shares as percentages."""
    pct = lambda x: "n/a" if pd.isna(x) else f"{100 * x:.1f}%"  # noqa: E731
    out = pd.DataFrame(
        {
            "sites": table["sites"],
            "marginal pages": table["pages_exclusive"].astype(int),
            "of inventory": table["page_yield_share"].map(pct),
            "orphans found": table["orphans_total"].astype(int),
            "orphans only by it": table["orphans_exclusive"].astype(int),
            "share of orphans": table["orphan_only_share"].map(pct),
            "median site share": table["orphan_only_share_median"].map(pct),
        }
    )
    out.index = out.index.set_levels(
        [out.index.levels[0], [style.CHANNEL_LABELS.get(c, c) for c in out.index.levels[1]]]
    )
    return out


def composition(channels: pd.DataFrame) -> pd.DataFrame:
    """Per class (and all sites): the orphans split by what detects them, pooled over sites.

    Columns: one per non-link channel (detected only by it), `several`, `orphans` (the total),
    and `sites`. The channel columns plus `several` add up to `orphans`.
    """
    rows = []
    for scope, data in _scopes(channels):
        totals = site_totals(data)
        per = _wide(data[data["channel"].isin(ORPHAN_CHANNELS)])
        row: dict[str, float | str] = {"architecture_class": scope}
        for ch in ORPHAN_CHANNELS:
            row[ch] = per.loc[per["channel"] == ch, "orphans_exclusive"].sum()
        row[SEVERAL] = totals["orphans_several_channels"].sum()
        row["orphans"] = totals["orphans"].sum()
        row["sites"] = len(totals)
        rows.append(row)
    out = pd.DataFrame(rows).set_index("architecture_class")
    parts = out[[*ORPHAN_CHANNELS, SEVERAL]].sum(axis=1)
    if not np.allclose(parts, out["orphans"]):
        raise ValueError("orphans detected only by one channel plus by several do not add up")
    return out


def composition_shares(comp: pd.DataFrame) -> pd.DataFrame:
    """composition() as shares of each row's orphans (NaN for a row without orphans)."""
    cols = [*ORPHAN_CHANNELS, SEVERAL]
    return comp[cols].div(comp["orphans"].where(comp["orphans"] > 0), axis=0)


# ---------- figure ----------


def plot_composition(channels: pd.DataFrame, ax=None, label_min: float = 0.07):
    """100% stacked bars, one per class and one for all sites: the share of orphans detected only
    by each channel, then by several. Segments of at least `label_min` carry their percentage;
    each bar is labelled with its orphan count."""
    import matplotlib.pyplot as plt

    comp = composition(channels)
    shares = composition_shares(comp)
    if ax is None:
        _, ax = plt.subplots(figsize=(style.DOUBLE_COLUMN, 0.55 * len(comp) + 1.2))
    segments = [*ORPHAN_CHANNELS, SEVERAL]
    colours = {**style.CHANNEL_COLOURS, SEVERAL: style.SEVERAL_CHANNELS_COLOUR}
    labels = {**style.CHANNEL_LABELS, SEVERAL: "Several channels"}
    rows = list(comp.index)
    y = np.arange(len(rows))[::-1]  # first class on top
    left = np.zeros(len(rows))
    for seg in segments:
        width = shares[seg].fillna(0).to_numpy()
        ax.barh(
            y,
            width,
            left=left,
            height=0.62,
            color=colours[seg],
            edgecolor=style.surface,
            linewidth=1.5,  # the surface gap between segments
            label=labels[seg],
        )
        for yi, x0, w in zip(y, left, width):
            if w >= label_min:
                ax.text(
                    x0 + w / 2,
                    yi,
                    f"{100 * w:.0f}%",
                    ha="center",
                    va="center",
                    fontsize=7.5,
                    color=style.text_on(_rgb(colours[seg])),
                )
        left += width
    for yi, name in zip(y, rows):
        n = int(comp.loc[name, "orphans"])
        sites = int(comp.loc[name, "sites"])
        plural = lambda k, word: f"{k} {word}{'' if k == 1 else 's'}"  # noqa: E731
        note = (plural(n, "orphan") if n > 0 else "no orphans") + ", " + plural(sites, "site")
        ax.text(1.01, yi, note, ha="left", va="center", fontsize=7.5, color=style.ink_secondary)
    ax.set_yticks(y, ["All sites" if r == ALL else style.class_label(r) for r in rows])
    ax.set_xlim(0, 1)
    ax.xaxis.set_major_formatter(lambda v, _: f"{100 * v:.0f}%")
    ax.set_xlabel("share of orphans, by the channels that detect them")
    ax.grid(axis="x")
    ax.grid(axis="y", visible=False)
    ax.set_axisbelow(True)
    ax.spines["left"].set_visible(False)
    ax.set_title("Orphans detected only by one channel", pad=26)
    ax.legend(
        ncols=len(segments),
        loc="lower left",
        bbox_to_anchor=(0, 1.0),
        handlelength=1,
        columnspacing=1.2,
        borderaxespad=0.2,
    )
    return ax


def _rgb(hex_colour: str) -> tuple[float, float, float]:
    return tuple(int(hex_colour[i : i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]


def figures(channels: pd.DataFrame, out_dir: str | Path) -> list[Path]:
    """The composition chart (PDF + PNG) in the shared style."""
    import matplotlib.pyplot as plt

    with style.style():
        ax = plot_composition(channels)
        written = style.save(ax.figure, Path(out_dir) / "e2_orphan_composition")
        plt.close(ax.figure)
    return written


def report(directory: str | Path) -> str:
    """Markdown: per class × channel marginal yields, then the orphan composition."""
    from .corpus import load_batch

    batch = load_batch(directory)
    table = class_table(batch.channels)
    comp = composition(batch.channels)
    shares = composition_shares(comp)
    shares.columns = [style.CHANNEL_LABELS.get(c, "Several channels") for c in shares.columns]
    shares.insert(0, "orphans", comp["orphans"].astype(int))
    parts = [
        f"## E2 channel ablation, batch {batch.batch_id}",
        "",
        "Each channel removed in turn and the reconciliation recomputed. Marginal pages: "
        "inventory pages lost without it; orphans only by it: orphans lost without it "
        "(pooled over the class's sites; the median is over sites with orphans).",
        "",
        display_table(table).to_markdown(),
        "",
        "### Orphans by the channels that detect them (share of each class's orphans)",
        "",
        shares.to_markdown(floatfmt=".3f"),
    ]
    return "\n".join(parts) + "\n"
