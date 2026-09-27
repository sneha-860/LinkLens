"""E4 across the corpus: re-crawl stability, site change vs method instability (e4.csv)."""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from linklens_analysis import corpus, e4, results, style
from linklens_analysis.__main__ import main

FIXTURES = Path(__file__).parent / "fixtures"


def synthetic_e4() -> pd.DataFrame:
    """4 sites per class. Documentation changes most; the crawl misses a few pages everywhere;
    identical pages always give identical results (samePages = 1)."""
    rng = np.random.default_rng(42)
    rows = []
    for cls, change in [("cms-blog", 0.05), ("ecommerce-catalogue", 0.1), ("documentation", 0.3)]:
        for i in range(4):
            site = f"{cls[:4]}-{i}"

            def put(comparison, metric, value):
                rows.append(
                    {
                        "batch_id": "syn",
                        "site_id": site,
                        "architecture_class": cls,
                        "run_a": 10 + i,
                        "run_b": 20 + i,
                        "comparison": comparison,
                        "metric": metric,
                        "value": value,
                    }
                )

            union = 200
            changed = round(union * change)
            missed = 4
            put("pages", "days_apart", 14 + rng.uniform(0, 1))
            put("pages", "union", union)
            put("pages", "unchanged", union - changed - missed - 2)
            put("pages", "changed", changed)
            put("pages", "site_gone", 2)
            put("pages", "site_link", 0)
            put("pages", "method_not-admitted", missed - 1)
            put("pages", "method_failed", 1)
            put("pages", "site_change_share", (changed + 2) / union)
            put("pages", "method_share", missed / union)
            for comp, disagreement in [
                ("observed", change + 0.02),
                ("siteChange", change),
                ("samePages", 0.0),
                ("coverageA", 0.02),
                ("coverageB", 0.01),
            ]:
                for metric in e4.METRICS:
                    put(comp, metric, 1 - disagreement)
    return pd.DataFrame(rows, columns=corpus.E4_COLUMNS)


@pytest.fixture()
def data() -> pd.DataFrame:
    return synthetic_e4()


def test_page_shares(data):
    s = e4.page_shares(data)
    assert len(s) == 12
    docs = s.loc[("documentation", "docu-0")]
    assert docs["changed"] == pytest.approx(60 / 200)
    assert docs["site"] == pytest.approx(2 / 200)
    assert docs["method"] == pytest.approx(4 / 200)
    assert docs[["unchanged", "changed", "site", "method"]].sum() == pytest.approx(1)


def test_summary_table(data):
    t = e4.summary_table(data)
    assert list(t.index) == ["CMS blog", "E-commerce / catalogue", "Documentation", "All sites"]
    assert t.loc["All sites", "sites"] == 12
    assert t.loc["Documentation", "pages changed (site)"] == "30.0%"
    assert t.loc["CMS blog", "Node overlap (Jaccard): observed"].startswith("0.930")
    assert t.loc["CMS blog", "Node overlap (Jaccard): same pages (method)"].startswith("1.000")
    assert t.loc["Documentation", "Top-k fix overlap (Jaccard): site change only"].startswith("0.700")
    # Every metric × the three default comparisons, plus sites, days and four page shares.
    assert t.shape[1] == 2 + 4 + len(e4.METRICS) * 3


def test_attribution(data):
    a = e4.attribution(data)
    docs = a.loc[("Documentation", "PageRank Spearman")]
    assert docs["observed disagreement"] == pytest.approx(0.32)
    assert docs["site change"] == pytest.approx(0.30)
    assert docs["method (same pages)"] == pytest.approx(0.0)
    assert docs["site share of observed"] == pytest.approx(0.30 / 0.32)


def test_loads_the_real_export():
    b = corpus.load_batch(FIXTURES / "corpus-export")
    s = e4.page_shares(b.e4)
    row = s.loc[("docs", "ocean")]
    assert row["pages"] == 9
    assert row["unchanged"] == pytest.approx(5 / 9)
    assert row["site"] == pytest.approx(1 / 9)  # /guides/b is gone
    assert row["method"] == pytest.approx(2 / 9)  # /guides/c failed, /about not admitted
    c = e4.comparisons(b.e4)
    assert c.loc[("docs", "ocean", "samePages"), "node_jaccard"] == 1
    assert set(b.e4_pages["cause"].dropna()) == {"site", "method"}


def test_single_run_e4_tables():
    tables = dict(results.tables(results.load(FIXTURES / "E4.json")))
    assert tables["Pages"].loc["unchanged", "value"] == 5
    assert list(tables["Comparisons"].index) == [
        "observed",
        "siteChange",
        "samePages",
        "coverageA",
        "coverageB",
    ]


def write_batch(tmp_path: Path, rows: pd.DataFrame) -> Path:
    d = tmp_path / "batch"
    d.mkdir()
    for name in ("metrics.csv", "policy_pairs.csv", "channels.csv", "e3.csv", "e4_pages.csv", "e5.csv", "e5_categories.csv", "e5_disagreements.csv", "e6.csv", "sites.csv", "stages.csv"):
        (d / name).write_bytes((FIXTURES / "corpus-export" / name).read_bytes())
    rows.to_csv(d / "e4.csv", index=False)
    return d


def test_report_and_cli(tmp_path, data, capsys):
    d = write_batch(tmp_path, data)
    md = e4.report(d)
    assert "## E4 re-crawl stability" in md and "Disagreement" in md and "| Documentation" in md
    assert main(["e4", str(d)]) == 0
    assert "same pages (method)" in capsys.readouterr().out


def test_report_before_a_recrawl(tmp_path):
    d = write_batch(tmp_path, pd.DataFrame(columns=corpus.E4_COLUMNS))
    assert "No re-crawl compared yet" in e4.report(d)
