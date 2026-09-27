"""E5 across the corpus: the Screaming Frog calibration (e5.csv, e5_categories.csv)."""

from pathlib import Path

import pandas as pd
import pytest

from linklens_analysis import corpus, e5, results
from linklens_analysis.__main__ import main

FIXTURES = Path(__file__).parent / "fixtures"
SITES = [("cms-blog", 4), ("ecommerce-catalogue", 3), ("documentation", 3)]


def synthetic() -> tuple[pd.DataFrame, pd.DataFrame]:
    """10 sites; under P0 the URL sets agree less (normalisation); documentation's depths agree
    least; one category (page-cap) is large on the catalogue sites only."""
    metrics, cats = [], []
    for cls, n in SITES:
        for i in range(n):
            site = f"{cls[:4]}-{i}"
            for policy, jac in [("P0", 0.7), ("P3", 0.9)]:
                values = {
                    "urls_linklens": 100 + i,
                    "urls_screaming_frog": 110,
                    "url_jaccard": jac - 0.01 * i,
                    "inlink_spearman": 0.8,
                    "inlink_spearman_column": 0.75,
                    "depth_exact": 0.5 if cls == "documentation" else 0.9,
                    "depth_within_one": 0.95,
                    "depth_spearman": 0.85,
                    "orphan_jaccard": 0.4,
                }
                for metric, value in values.items():
                    metrics.append(
                        {"batch_id": "syn", "site_id": site, "architecture_class": cls, "run_id": 1,
                         "policy": policy, "policy_version": f"{policy}@1.0.0", "metric": metric, "value": value}
                    )
                def cat(kind, category, count, share, large, text):
                    cats.append(
                        {"batch_id": "syn", "site_id": site, "architecture_class": cls, "policy": policy,
                         "kind": kind, "category": category, "count": count, "share": share, "large": int(large),
                         "explanation": text, "examples": "https://x.test/a"}
                    )
                if policy == "P0":
                    cat("url-only-screaming-frog", "normalisation", 8, 0.8, True, "They are one page under P3.")
                cat("url-only-screaming-frog", "page-cap", 5 if cls == "ecommerce-catalogue" else 1,
                    0.5, cls == "ecommerce-catalogue", "LinkLens stopped at its page cap.")
                cat("depth", "link-not-extracted", 3, 0.6, True, "A link LinkLens does not extract (JavaScript).")
    return (
        pd.DataFrame(metrics, columns=corpus.E5_COLUMNS),
        pd.DataFrame(cats, columns=corpus.E5_CATEGORIES_COLUMNS),
    )


def test_calibration_table():
    metrics, _ = synthetic()
    t = e5.calibration_table(metrics)
    assert list(t.index.get_level_values("class").unique()) == [
        "CMS blog",
        "E-commerce / catalogue",
        "Documentation",
        "All sites",
    ]
    assert list(t.loc["All sites"].index) == ["P0", "P3"]
    assert t.loc[("All sites", "P3"), "sites"] == 10
    # Normalisation: the URL sets agree more under P3 than under P0.
    assert t.loc[("CMS blog", "P3"), "URL Jaccard"].startswith("0.885")
    assert t.loc[("CMS blog", "P0"), "URL Jaccard"].startswith("0.685")
    assert t.loc[("Documentation", "P3"), "depth exact"].startswith("0.500")
    assert t.loc[("CMS blog", "P3"), "URLs LinkLens / SF (median)"] == "102 / 110"


def test_large_categories_are_all_explained():
    _, cats = synthetic()
    large = e5.large_categories(cats)
    keys = list(large.index)
    assert ("P0", "URL only in Screaming Frog", "normalisation") in keys
    assert ("P3", "crawl depth", "link-not-extracted") in keys
    cap = large.loc[("P3", "URL only in Screaming Frog", "page-cap")]
    assert cap["sites large"] == 3  # the catalogue sites only
    assert cap["count"] == 3 * 5 + 7 * 1
    assert cap["explanation"] == "LinkLens stopped at its page cap."
    assert cap["share of kind"] == pytest.approx(1.0)
    assert (large["explanation"] != "").all()


def test_loads_the_real_export():
    b = corpus.load_batch(FIXTURES / "corpus-export")
    w = e5.site_table(b.e5)
    assert w.loc[("docs", "ocean", "P3"), "urls_common"] == 9
    assert w.loc[("docs", "ocean", "P0"), "urls_common"] == 8
    assert set(b.e5_categories["policy"]) == {"P0", "P3"}
    assert b.e5_categories["explanation"].str.len().min() > 20
    t = e5.calibration_table(b.e5)
    assert t.loc[("docs", "P3"), "sites"] == 1


def test_single_run_e5_tables():
    tables = dict(results.tables(results.load(FIXTURES / "E5.json")))
    assert list(tables["Calibration"].index) == ["P0", "P3"]
    cats = tables["Disagreement categories"]
    assert ("P0", "url-only-screaming-frog", "normalisation") in cats.index


def write_batch(tmp_path: Path, metrics: pd.DataFrame, cats: pd.DataFrame) -> Path:
    d = tmp_path / "batch"
    d.mkdir()
    for name in ("metrics.csv", "policy_pairs.csv", "channels.csv", "e3.csv", "e4.csv", "e4_pages.csv",
                 "e5_disagreements.csv", "e6.csv", "sites.csv", "stages.csv"):
        (d / name).write_bytes((FIXTURES / "corpus-export" / name).read_bytes())
    metrics.to_csv(d / "e5.csv", index=False)
    cats.to_csv(d / "e5_categories.csv", index=False)
    return d


def test_report_and_cli(tmp_path, capsys):
    metrics, cats = synthetic()
    d = write_batch(tmp_path, metrics, cats)
    md = e5.report(d)
    assert "## E5 Screaming Frog calibration" in md and "(10 sites)" in md
    assert "**P3 · URL only in Screaming Frog · page-cap**" in md
    assert "LinkLens stopped at its page cap." in md
    assert main(["e5", str(d)]) == 0
    assert "Large disagreement categories" in capsys.readouterr().out


def test_report_before_an_import(tmp_path):
    d = write_batch(
        tmp_path, pd.DataFrame(columns=corpus.E5_COLUMNS), pd.DataFrame(columns=corpus.E5_CATEGORIES_COLUMNS)
    )
    assert "No Screaming Frog exports imported yet" in e5.report(d)
