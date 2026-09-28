"""E3 across the corpus: top-k fixes applied together, LinkLens vs three baselines (e3.csv)."""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from scipy import stats

from linklens_analysis import corpus, e3, style
from linklens_analysis.__main__ import main

FIXTURES = Path(__file__).parent / "fixtures"
KS = [10, 25, 50]


def synthetic_e3(seed: int = 42) -> pd.DataFrame:
    """6 sites per class. LinkLens beats random everywhere; the cosine and PageRank baselines
    win on a few sites; site docu-5 has a pool smaller than every k (all methods tie)."""
    rng = np.random.default_rng(seed)
    rows = []

    def put(cls, site, k, method, metric, value):
        rows.append(
            {
                "batch_id": "syn",
                "site_id": site,
                "architecture_class": cls,
                "run_id": 1,
                "policy": "P3",
                "policy_version": "P3@1.0.0",
                "k": k,
                "method": method,
                "metric": metric,
                "value": value,
            }
        )

    for cls, size in [("cms-blog", 1.0), ("ecommerce-catalogue", 0.5), ("documentation", 2.0)]:
        for i in range(6):
            site = f"{cls[:4]}-{i}"
            put(cls, site, None, "site", "target_pagerank_before", 0.1 * size)
            put(cls, site, None, "site", "pool_pairs", 5 if site == "docu-5" else 200)
            for k in KS:
                ours = size * 1e-3 * k * (1 + rng.uniform(0, 0.2))
                values = {
                    "linklens": ours,
                    "random": ours * rng.uniform(0.2, 0.5),
                    # cosine: loses on most sites, wins on site 0 of each class
                    "highestCosine": ours * (1.2 if i == 0 else rng.uniform(0.5, 0.9)),
                    "highestPagerank": ours * (1.1 if i in (0, 1) else rng.uniform(0.6, 0.95)),
                }
                if site == "docu-5":
                    values = {m: 0.004 for m in values}
                for m, v in values.items():
                    put(cls, site, k, m, "total_delta_pr", v)
                    put(cls, site, k, m, "selected", min(k, 5 if site == "docu-5" else 200))
                put(cls, site, k, "random", "total_delta_pr_sd", 1e-4)
    return pd.DataFrame(rows, columns=corpus.E3_COLUMNS)


@pytest.fixture()
def data() -> pd.DataFrame:
    return synthetic_e3()


def test_site_totals(data):
    t = e3.site_totals(data)
    assert list(t.columns) == e3.METHODS
    assert t.shape == (18 * 3, 4)
    assert list(t.index.get_level_values("k").unique()) == KS
    rel = e3.site_totals(data, "relative")
    site = ("documentation", "docu-1", 25)
    assert rel.loc[site, "linklens"] == pytest.approx(t.loc[site, "linklens"] / 0.2)
    with pytest.raises(ValueError):
        e3.site_totals(data, "log")


def test_rank_biserial():
    assert e3.rank_biserial(np.array([1.0, 2.0, 3.0])) == 1
    assert e3.rank_biserial(np.array([-1.0, -2.0])) == -1
    # |d| ranks: 1 → 1, 2 → 2, 3 → 3; R+ = 1 + 3, R− = 2: (4 − 2) / 6.
    assert e3.rank_biserial(np.array([1.0, -2.0, 3.0, 0.0])) == pytest.approx(2 / 6)
    assert np.isnan(e3.rank_biserial(np.array([0.0, 0.0])))


def test_paired_test_matches_scipy_and_drops_ties():
    ours = np.array([5.0, 4.0, 3.0, 2.0, 1.0, 1.0])
    theirs = np.array([1.0, 1.0, 1.0, 3.0, 0.5, 1.0])
    r = e3.paired_test(ours, theirs)
    assert (r["wins"], r["ties"], r["losses"]) == (4, 1, 1)
    assert r["nonzero"] == 5 and r["sites"] == 6
    d = (ours - theirs)[ours != theirs]
    assert r["p"] == pytest.approx(stats.wilcoxon(d).pvalue)
    assert r["median difference"] == pytest.approx(np.median(ours - theirs))
    none = e3.paired_test(np.ones(3), np.ones(3))
    assert np.isnan(none["p"]) and none["ties"] == 3


def test_paired_tests_across_sites(data):
    t = e3.paired_tests(data)
    assert list(t.index) == [(k, b) for k in KS for b in e3.BASELINES]
    rnd = t.loc[(10, "random")]
    # LinkLens beats random on every site but the tied one.
    assert (rnd["wins"], rnd["ties"], rnd["losses"]) == (17, 1, 0)
    assert rnd["r (rank-biserial)"] == 1
    assert rnd["p"] < 1e-4
    cos = t.loc[(10, "highestCosine")]
    assert cos["losses"] == 3  # site 0 of each class
    assert 0 < cos["r (rank-biserial)"] < 1
    # Holm within each k: never below the raw p, and the smallest p is multiplied by 3.
    for k in KS:
        x = t.loc[k]
        assert (x["p_holm"] >= x["p"] - 1e-15).all()
        assert x["p_holm"].min() == pytest.approx(min(1.0, 3 * x["p"].min()))


def test_class_tables(data):
    tables = e3.class_tables(data)
    assert list(tables) == [*style.CLASSES, e3.ALL]
    blog = tables["cms-blog"]
    assert list(blog.index.get_level_values("k").unique()) == KS
    assert list(blog.loc[10].index) == [e3.METHOD_LABELS[m] for m in e3.METHODS]
    assert blog.loc[(10, "LinkLens"), "sites"] == 6
    assert blog.loc[(10, "LinkLens"), "wins/ties/losses"] == ""
    assert blog.loc[(10, "Random admissible donor"), "wins/ties/losses"] == "6/0/0"
    assert blog.loc[(10, "Highest PageRank donor"), "wins/ties/losses"] == "4/0/2"
    everyone = tables[e3.ALL]
    assert everyone.loc[(50, "LinkLens"), "sites"] == 18
    docs = e3.class_table(data, "documentation")
    assert docs.loc[(10, "Random admissible donor"), "wins/ties/losses"] == "5/1/0"


def test_loads_the_real_export():
    b = corpus.load_batch(FIXTURES / "corpus-export")
    t = e3.site_totals(b.e3)
    assert list(t.index.get_level_values("k").unique()) == KS
    # The fixture's pool (2 fixes) is below every k: every method applies it all, so no
    # difference is informative and the test is undefined.
    tests = e3.paired_tests(b.e3)
    assert (tests["ties"] == 1).all()
    assert tests["p"].isna().all()


def test_rejects_unknown_methods(tmp_path):
    d = tmp_path / "b"
    d.mkdir()
    for name in ("metrics.csv", "policy_pairs.csv", "channels.csv", "e4.csv", "e4_pages.csv", "e5.csv", "e5_categories.csv", "e5_disagreements.csv", "e6.csv", "e7.csv", "e7_sigma_pairs.csv", "sites.csv", "stages.csv"):
        (d / name).write_bytes((FIXTURES / "corpus-export" / name).read_bytes())
    bad = synthetic_e3()
    bad.loc[0, "method"] = "oracle"
    bad.to_csv(d / "e3.csv", index=False)
    with pytest.raises(ValueError, match="unknown methods"):
        corpus.load_batch(d)


def test_report_and_cli(tmp_path, data, capsys):
    d = tmp_path / "batch"
    d.mkdir()
    for name in ("metrics.csv", "policy_pairs.csv", "channels.csv", "e4.csv", "e4_pages.csv", "e5.csv", "e5_categories.csv", "e5_disagreements.csv", "e6.csv", "e7.csv", "e7_sigma_pairs.csv", "sites.csv", "stages.csv"):
        (d / name).write_bytes((FIXTURES / "corpus-export" / name).read_bytes())
    data.to_csv(d / "e3.csv", index=False)
    md = e3.report(d)
    assert "## E3 fixes vs baselines" in md
    for label in ("### CMS blog", "### E-commerce / catalogue", "### Documentation", "### All sites"):
        assert label in md
    assert "Highest PageRank donor" in md
    assert main(["e3", str(d), "--measure", "relative"]) == 0
    assert "targets' PR before" in capsys.readouterr().out
