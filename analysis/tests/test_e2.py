"""E2 across the corpus: each discovery channel removed in turn (channels.csv)."""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from linklens_analysis import corpus, e2, results, style
from linklens_analysis.__main__ import main
from plotting import needs_matplotlib

FIXTURES = Path(__file__).parent / "fixtures"

# Per site: each orphan's detecting non-link channels, and pages only each channel lists.
SITES = {
    # Blogs: the feed is the main orphan detector.
    ("cms-blog", "blog-a"): {
        "orphans": [["feed"], ["feed"], ["feed", "xml_sitemap"], ["llms_txt"]],
        "pages_only": {"link_graph": 90, "feed": 3, "xml_sitemap": 1},
    },
    ("cms-blog", "blog-b"): {
        "orphans": [["feed"], ["xml_sitemap", "robots_sitemap"]],
        "pages_only": {"link_graph": 120, "feed": 2},
    },
    # Catalogue: sitemaps.
    ("ecommerce-catalogue", "shop-a"): {
        "orphans": [["xml_sitemap"]] * 6 + [["xml_sitemap", "robots_sitemap"]] * 2,
        "pages_only": {"link_graph": 300, "xml_sitemap": 6},
    },
    # Docs: no orphans at all.
    ("documentation", "docs-a"): {"orphans": [], "pages_only": {"link_graph": 200}},
}


def synthetic_channels() -> pd.DataFrame:
    rows = []
    for (cls, site), spec in SITES.items():
        orphans = spec["orphans"]
        shared = 50  # pages every channel shares with the link graph
        inventory = shared + sum(spec["pages_only"].values()) + len(orphans)
        several = sum(1 for o in orphans if len(o) > 1)

        def put(channel, metric, value):
            rows.append(
                {
                    "batch_id": "syn",
                    "site_id": site,
                    "architecture_class": cls,
                    "run_id": 1,
                    "policy": "P3",
                    "policy_version": "P3@1.0.0",
                    "channel": channel,
                    "metric": metric,
                    "value": value,
                }
            )

        put("all", "inventory", inventory)
        put("all", "orphans", len(orphans))
        put("all", "orphans_several_channels", several)
        for ch in style.CHANNELS:
            found = sum(1 for o in orphans if ch in o)
            only = sum(1 for o in orphans if o == [ch])
            pages_only = spec["pages_only"].get(ch, 0) + only
            put(ch, "pages_total", shared + pages_only + found - only)
            put(ch, "pages_exclusive", pages_only)
            put(ch, "orphans_total", found)
            put(ch, "orphans_exclusive", only)
            if orphans:
                put(ch, "orphans_exclusive_share", only / len(orphans))
            put(ch, "inventory_without", inventory - pages_only)
            put(ch, "orphans_without", len(orphans) - only)
    return pd.DataFrame(rows, columns=corpus.CHANNELS_COLUMNS)


@pytest.fixture()
def channels() -> pd.DataFrame:
    return synthetic_channels()


def test_loads_the_real_export():
    b = corpus.load_batch(FIXTURES / "corpus-export")
    c = b.channels
    assert set(c["channel"]) == {*style.CHANNELS, "all"}
    table = e2.class_table(c)
    # The fixture's one orphan is found by the sitemap and the feed: no channel alone.
    assert table.loc[("docs", "xml_sitemap"), "orphans_total"] == 1
    assert table["orphans_exclusive"].sum() == 0
    comp = e2.composition(c)
    assert comp.loc["docs", e2.SEVERAL] == 1 and comp.loc["docs", "orphans"] == 1


def test_rejects_unknown_channels(tmp_path):
    d = tmp_path / "b"
    d.mkdir()
    for name in ("metrics.csv", "policy_pairs.csv", "e3.csv", "e4.csv", "e4_pages.csv", "e5.csv", "e5_categories.csv", "e5_disagreements.csv", "e6.csv", "e7.csv", "e7_sigma_pairs.csv", "sites.csv", "stages.csv"):
        (d / name).write_bytes((FIXTURES / "corpus-export" / name).read_bytes())
    bad = synthetic_channels()
    bad.loc[0, "channel"] = "twitter"
    bad.to_csv(d / "channels.csv", index=False)
    with pytest.raises(ValueError, match="unknown channels"):
        corpus.load_batch(d)


def test_class_table(channels):
    t = e2.class_table(channels)
    scopes = t.index.get_level_values("architecture_class").unique().tolist()
    assert scopes == [*style.CLASSES, e2.ALL]
    assert t.index.get_level_values("channel").unique().tolist() == list(style.CHANNELS)

    # Blogs: 6 orphans over 2 sites; the feed alone detects 3 of them.
    feed = t.loc[("cms-blog", "feed")]
    assert feed["orphans_total"] == 4
    assert feed["orphans_exclusive"] == 3
    assert feed["orphan_only_share"] == pytest.approx(3 / 6)
    assert feed["orphan_only_share_median"] == pytest.approx(np.median([2 / 4, 1 / 2]))
    assert feed["pages_exclusive"] == 3 + 2 + 3  # listed pages + the orphans only it finds
    # The link graph never detects an orphan alone, but it yields most pages.
    lg = t.xs("link_graph", level="channel")
    assert (lg["orphans_exclusive"] == 0).all()
    assert (lg["page_yield_share"] > 0.5).all()
    # Documentation has no orphans: shares are undefined, not 0.
    docs = t.xs("documentation", level="architecture_class")
    assert docs["orphan_only_share"].isna().all()
    assert docs["orphan_only_share_median"].isna().all()
    assert t.loc[("documentation", "feed"), "sites_with_orphans"] == 0
    # Pooled over all sites.
    assert t.loc[(e2.ALL, "xml_sitemap"), "orphans_exclusive"] == 6
    assert t.loc[(e2.ALL, "xml_sitemap"), "orphan_only_share"] == pytest.approx(6 / 14)
    assert t.loc[(e2.ALL, "xml_sitemap"), "sites"] == 4


def test_composition_adds_up(channels):
    comp = e2.composition(channels)
    assert list(comp.index) == [*style.CLASSES, e2.ALL]
    assert comp.loc["cms-blog", "feed"] == 3
    assert comp.loc["cms-blog", "llms_txt"] == 1
    assert comp.loc["cms-blog", e2.SEVERAL] == 2
    assert comp.loc["ecommerce-catalogue", "xml_sitemap"] == 6
    assert comp.loc[e2.ALL, "orphans"] == 14
    shares = e2.composition_shares(comp)
    np.testing.assert_allclose(shares.drop(index="documentation").sum(axis=1), 1)
    assert shares.loc["documentation"].isna().all()


def test_composition_checks_consistency(channels):
    broken = channels.copy()
    mask = (broken["channel"] == "all") & (broken["metric"] == "orphans") & (broken["site_id"] == "blog-a")
    broken.loc[mask, "value"] = 99
    with pytest.raises(ValueError, match="do not add up"):
        e2.composition(broken)


def test_display_table(channels):
    d = e2.display_table(e2.class_table(channels))
    assert ("cms-blog", "RSS/Atom") in d.index
    assert d.loc[("cms-blog", "RSS/Atom"), "share of orphans"] == "50.0%"
    assert d.loc[("documentation", "RSS/Atom"), "share of orphans"] == "n/a"


def test_single_run_e2_has_a_removals_table():
    tables = dict(results.tables(results.load(FIXTURES / "E2.json")))
    t = tables["Each channel removed"]
    assert list(t.index) == list(style.CHANNELS)
    assert t.loc["link_graph", "orphansExclusive"] == 0


def write_batch(tmp_path: Path, channels: pd.DataFrame) -> Path:
    d = tmp_path / "batch"
    d.mkdir()
    for name in ("metrics.csv", "policy_pairs.csv", "e3.csv", "e4.csv", "e4_pages.csv", "e5.csv", "e5_categories.csv", "e5_disagreements.csv", "e6.csv", "e7.csv", "e7_sigma_pairs.csv", "sites.csv", "stages.csv"):
        (d / name).write_bytes((FIXTURES / "corpus-export" / name).read_bytes())
    channels.to_csv(d / "channels.csv", index=False)
    return d


def test_report_and_cli(tmp_path, channels, capsys):
    d = write_batch(tmp_path, channels)
    md = e2.report(d)
    assert "## E2 channel ablation" in md
    assert "RSS/Atom" in md and "Several channels" in md
    assert main(["e2", str(d)]) == 0
    assert "Orphans by the channels" in capsys.readouterr().out


@needs_matplotlib
def test_stacked_bar(tmp_path, channels):
    written = e2.figures(channels, tmp_path / "fig")
    assert [p.name for p in written] == ["e2_orphan_composition.pdf", "e2_orphan_composition.png"]
    assert all(p.stat().st_size > 0 for p in written)


@needs_matplotlib
def test_cli_figure(tmp_path, channels):
    d = write_batch(tmp_path, channels)
    assert main(["e2", str(d), "--figures", str(tmp_path / "f")]) == 0
    assert (tmp_path / "f" / "e2_orphan_composition.pdf").exists()
