"""The shared plotting style for every LinkLens figure.

Call `apply()` once (or use `with style():`) before plotting, then take colours from the
constants here rather than choosing them per figure:

- `CLASS_COLOURS` / `CLASS_MARKERS`: one fixed colour and marker per architecture class, in
  corpus order. Colour follows the class, never its rank, so a figure that shows two of the
  three classes keeps their colours. The marker is the secondary encoding (greyscale print,
  colour-vision deficiency).
- `POLICY_COLOURS`: P0–P5 are ordered (each policy coarser than the last), so they get one hue
  from light to dark, never a categorical palette.
- `ink`, `grid`, … : the recessive chrome.

The categorical slots are the first three of the reference palette (blue, orange, aqua); those
three validate against each other for every pair (CVD ΔE ≥ 9, normal-vision ΔE ≥ 24). A fourth
class would need re-validation, not a new hue picked by eye.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Sequence

from cycler import cycler

# matplotlib is imported only when a style is applied or a figure saved, so the statistics work
# where matplotlib's compiled extensions cannot load.

# Architecture classes, in corpus.yaml order.
CLASSES: tuple[str, ...] = ("cms-blog", "ecommerce-catalogue", "documentation")
CLASS_LABELS: dict[str, str] = {
    "cms-blog": "CMS blog",
    "ecommerce-catalogue": "E-commerce / catalogue",
    "documentation": "Documentation",
}
# For tick labels at single-column width.
CLASS_SHORT_LABELS: dict[str, str] = {
    "cms-blog": "Blog",
    "ecommerce-catalogue": "Catalogue",
    "documentation": "Docs",
}
CLASS_COLOURS: dict[str, str] = {
    "cms-blog": "#2a78d6",  # blue
    "ecommerce-catalogue": "#eb6834",  # orange
    "documentation": "#1baf7a",  # aqua
}
CLASS_MARKERS: dict[str, str] = {
    "cms-blog": "o",
    "ecommerce-catalogue": "s",
    "documentation": "^",
}

# Discovery channels, in the pipeline's order (packages/core/src/discovery/channels.ts).
CHANNELS: tuple[str, ...] = (
    "link_graph", "xml_sitemap", "robots_sitemap", "html_sitemap", "feed", "llms_txt",
)
CHANNEL_LABELS: dict[str, str] = {
    "link_graph": "Link graph",
    "xml_sitemap": "XML sitemap",
    "robots_sitemap": "robots.txt Sitemap",
    "html_sitemap": "HTML sitemap",
    "feed": "RSS/Atom",
    "llms_txt": "llms.txt",
}
# The five channels that can reveal an orphan take categorical slots 1–5 in this fixed order
# (they validate as adjacent pairs, as in a stacked bar); "several channels" is a dark neutral
# grey, drawn last.
CHANNEL_COLOURS: dict[str, str] = {
    "xml_sitemap": "#2a78d6",  # blue
    "robots_sitemap": "#eb6834",  # orange
    "html_sitemap": "#1baf7a",  # aqua
    "feed": "#eda100",  # yellow
    "llms_txt": "#e87ba4",  # magenta
}
SEVERAL_CHANNELS_COLOUR = "#6b6962"  # neutral; clears CVD separation against every slot above

POLICIES: tuple[str, ...] = ("P0", "P1", "P2", "P3", "P4", "P5")
# Ordinal blue ramp: the lightest step still clears 2:1 on the light surface.
POLICY_COLOURS: dict[str, str] = dict(
    zip(POLICIES, ["#86b6ef", "#5598e7", "#2a78d6", "#256abf", "#184f95", "#0d366b"])
)

# Sequential (magnitude, heatmaps): one hue, light → dark (the blue ramp, steps 100–700).
SEQUENTIAL: tuple[str, ...] = (
    "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5",
    "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b",
)
# Diverging (signed values): blue and red arms around a neutral grey midpoint (never a hue).
DIVERGING: tuple[str, ...] = ("#2a78d6", "#86b6ef", "#f0efec", "#f0a3a2", "#e34948")

# Chrome and ink (light surface).
surface = "#fcfcfb"
ink = "#0b0b0b"
ink_secondary = "#52514e"
muted = "#898781"
grid = "#e1e0d9"
baseline = "#c3c2b7"

FONT = ["Segoe UI", "Helvetica Neue", "Arial", "DejaVu Sans", "sans-serif"]

RC: dict[str, object] = {
    "figure.facecolor": surface,
    "figure.dpi": 110,
    "savefig.dpi": 300,
    "savefig.facecolor": surface,
    "savefig.bbox": "tight",
    "figure.constrained_layout.use": True,
    "axes.facecolor": surface,
    "axes.edgecolor": baseline,
    "axes.linewidth": 0.8,
    "axes.labelcolor": ink_secondary,
    "axes.titlecolor": ink,
    "axes.titlesize": 11,
    "axes.titleweight": "semibold",
    "axes.titlelocation": "left",
    "axes.labelsize": 9.5,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "axes.grid.axis": "y",
    "axes.axisbelow": True,
    "axes.prop_cycle": cycler(color=[CLASS_COLOURS[c] for c in CLASSES]),
    "grid.color": grid,
    "grid.linewidth": 0.6,
    "xtick.color": muted,
    "ytick.color": muted,
    "xtick.labelcolor": ink_secondary,
    "ytick.labelcolor": ink_secondary,
    "xtick.labelsize": 8.5,
    "ytick.labelsize": 8.5,
    "xtick.major.size": 0,
    "ytick.major.size": 0,
    "legend.frameon": False,
    "legend.fontsize": 8.5,
    "legend.labelcolor": ink_secondary,
    "lines.linewidth": 2,
    "lines.markersize": 6,
    "patch.linewidth": 0,
    "font.family": "sans-serif",
    "font.sans-serif": FONT,
    "font.size": 9.5,
    "text.color": ink,
    "pdf.fonttype": 42,  # embed TrueType, so text stays text in the PDF
    "ps.fonttype": 42,
    "svg.fonttype": "none",
}

# Figure widths for a two-column paper (inches).
SINGLE_COLUMN = 3.5
DOUBLE_COLUMN = 7.2


def apply() -> None:
    """Set the LinkLens style for the rest of the session."""
    import matplotlib as mpl

    mpl.rcParams.update(RC)


@contextmanager
def style() -> Iterator[None]:
    """The LinkLens style for one block only."""
    import matplotlib as mpl

    with mpl.rc_context(RC):
        yield


def sequential_cmap(name: str = "linklens-sequential"):
    """The sequential ramp as a matplotlib colormap (missing values drawn as the surface)."""
    from matplotlib.colors import LinearSegmentedColormap

    return LinearSegmentedColormap.from_list(name, list(SEQUENTIAL)).with_extremes(bad=surface)


def diverging_cmap(name: str = "linklens-diverging"):
    """The diverging pair as a matplotlib colormap; centre it on 0 (TwoSlopeNorm or ±limit)."""
    from matplotlib.colors import LinearSegmentedColormap

    return LinearSegmentedColormap.from_list(name, list(DIVERGING)).with_extremes(bad=surface)


def _luminance(rgb) -> float:
    lin = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in rgb[:3]]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def text_on(rgba) -> str:
    """Ink or white, whichever has the higher WCAG contrast on a fill colour (0–1 RGB)."""
    fill = _luminance(rgba)
    ink_rgb = tuple(int(ink[i : i + 2], 16) / 255 for i in (1, 3, 5))
    on_ink = (fill + 0.05) / (_luminance(ink_rgb) + 0.05)
    on_white = 1.05 / (fill + 0.05)
    return ink if on_ink >= on_white else "#ffffff"


def class_colour(cls: str) -> str:
    try:
        return CLASS_COLOURS[cls]
    except KeyError:
        raise KeyError(
            f"no colour for architecture class {cls!r}: add it to style.CLASSES "
            "(and re-validate the palette) rather than letting matplotlib pick one"
        ) from None


def class_label(cls: str, short: bool = False) -> str:
    return (CLASS_SHORT_LABELS if short else CLASS_LABELS).get(cls, cls)


def ordered_classes(present: Sequence[str]) -> list[str]:
    """The classes present, in the fixed order (unknown classes last, sorted)."""
    known = [c for c in CLASSES if c in present]
    return known + sorted(set(present) - set(CLASSES))


def save(fig, path: str | Path, formats: Sequence[str] = ("pdf", "png")) -> list[Path]:
    """Save a figure as PDF (vector, for the paper) and PNG (for review)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = []
    for ext in formats:
        p = path.with_suffix(f".{ext}")
        fig.savefig(p, metadata={"CreationDate": None} if ext == "pdf" else None)
        out.append(p)
    return out
