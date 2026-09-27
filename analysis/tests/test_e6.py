"""E6 across the corpus: link-masking recovery, and the C5 test (hybrid vs cosine)."""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from scipy import stats

from linklens_analysis import corpus, e6, results
from linklens_analysis.__main__ import main

FIXTURES = Path(__file__).parent / "fixtures"
CLASSES = [("cms-blog", 4), ("ecommerce-catalogue", 4), ("documentation", 4)]


def synthetic(hybrid_gain: float, seed: int = 42) -> pd.DataFrame:
    """12 sites × 3 repeats. Cosine's MRR varies by site; the hybrid adds `hybrid_gain` (plus a
    little noise); random is its expectation."""
    rng = np.random.default_rng(seed)
    rows = []
    for cls, n in CLASSES:
        for i in range(n):
            site = f"{cls[:4]}-{i}"
            base = rng.uniform(0.2, 0.5)
            for repeat in range(3):
                def put(method, metric, value):
                    rows.append(
                        {"batch_id": "syn", "site_id": site, "architecture_class": cls, "run_id": 1,
                         "policy": "P3", "repeat": repeat, "seed": 42 + repeat, "method": method,
                         "metric": metric, "value": value}
                    )
                put("masking", "share", 0.1 + 0.1 * rng.uniform())
                put("masking", "eligible_pairs", 200)
                put("masking", "masked", 30)
                put("masking", "targets", 25)
                put("masking", "queries", 30)
                noise = rng.normal(0, 0.005)
                for method, mrr in [
                    ("cosine", base),
                    ("refGateCosine", base + hybrid_gain + noise),
                    ("ref", base - 0.05),
                    ("random", 0.02),
                ]:
                    put(method, "mrr", mrr)
                    put(method, "recall@5", min(1, 2 * mrr))
                    put(method, "recall@10", min(1, 2.5 * mrr))
                    put(method, "recall@20", min(1, 3 * mrr))
                    put(method, "auc", 0.5 if method == "random" else 0.5 + mrr)
                    put(method, "queries", 30)
    return pd.DataFrame(rows, columns=corpus.E6_COLUMNS)


def test_site_means_average_the_repeats():
    d = synthetic(0.05)
    m = e6.site_means(d)
    assert m.loc[("cms-blog", "cms--0", "random"), "mrr"] == pytest.approx(0.02)
    assert len(m.xs("cosine", level="method")) == 12
    s = e6.masking_summary(d)
    assert (s["repeats"] == 3).all()
    assert s["share"].between(0.1, 0.2).all()


def test_results_table():
    t = e6.results_table(synthetic(0.05))
    assert list(t.index.get_level_values("class").unique()) == [
        "CMS blog",
        "E-commerce / catalogue",
        "Documentation",
        "All sites",
    ]
    assert list(t.loc["All sites"].index) == [
        "Hybrid (REF-gated cosine)",
        "Cosine",
        "REF",
        "Random",
    ]
    assert list(t.columns) == ["sites", "MRR", "R@5", "R@10", "R@20", "AUC"]
    assert t.loc[("All sites", "Random"), "MRR"] == "0.020 [0.020, 0.020]"
    assert t.loc[("All sites", "Cosine"), "sites"] == 12


def test_paired_test_matches_scipy():
    d = synthetic(0.05)
    t = e6.paired_test(d)
    assert list(t.index) == ["mrr", "recall@10", "auc"]
    m = e6.site_means(d)
    diff = (m.xs("refGateCosine", level="method")["mrr"] - m.xs("cosine", level="method")["mrr"]).to_numpy()
    assert t.loc["mrr", "p (a > b)"] == pytest.approx(stats.wilcoxon(diff, alternative="greater").pvalue)
    assert t.loc["mrr", "p (two-sided)"] == pytest.approx(stats.wilcoxon(diff).pvalue)
    assert t.loc["mrr", "wins/ties/losses"] == "12/0/0"
    assert t.loc["mrr", "r (rank-biserial)"] == 1
    assert (t["p_holm (a > b)"] >= t["p (a > b)"] - 1e-15).all()


def test_c5_verdicts():
    supported = e6.c5_verdict(e6.paired_test(synthetic(0.05)))
    assert supported.startswith("C5 supported")
    refuted = e6.c5_verdict(e6.paired_test(synthetic(-0.05)))
    assert refuted.startswith("C5 refuted")
    neutral = e6.c5_verdict(e6.paired_test(synthetic(0.0, seed=3)))
    assert neutral.startswith("C5 not supported")
    empty = pd.DataFrame(columns=["p (a > b)"])
    assert e6.c5_verdict(empty).startswith("C5 cannot be tested")


def test_per_class_test():
    t = e6.paired_test(synthetic(0.05), scope="documentation")
    assert t.loc["mrr", "sites"] == 4


def test_loads_the_real_export():
    b = corpus.load_batch(FIXTURES / "corpus-export")
    m = e6.site_means(b.e6)
    assert m.loc[("docs", "ocean", "random"), "auc"] == 0.5
    assert set(e6.METHODS) <= set(m.index.get_level_values("method"))
    s = e6.masking_summary(b.e6)
    assert s.loc[("docs", "ocean"), "repeats"] == 5


def test_single_run_e6_tables():
    tables = dict(results.tables(results.load(FIXTURES / "E6.json")))
    t = tables["Link-masking recovery"]
    assert {"refGateCosine", "cosine", "random"} <= set(t.index)
    assert t.loc["random", "AUC"] == 0.5
    assert len(tables["Repeats"]) == 5


def write_batch(tmp_path: Path, rows: pd.DataFrame) -> Path:
    d = tmp_path / "batch"
    d.mkdir()
    for f in (FIXTURES / "corpus-export").glob("*.csv"):
        if f.name != "e6.csv":
            (d / f.name).write_bytes(f.read_bytes())
    rows.to_csv(d / "e6.csv", index=False)
    return d


def test_report_and_cli(tmp_path, capsys):
    d = write_batch(tmp_path, synthetic(0.05))
    md = e6.report(d)
    assert "C5 refutation test" in md and "C5 supported" in md
    assert "#### Documentation" in md
    assert main(["e6", str(d), "--alpha", "0.01"]) == 0
    assert "Hybrid (REF-gated cosine)" in capsys.readouterr().out


def test_report_without_results(tmp_path):
    d = write_batch(tmp_path, pd.DataFrame(columns=corpus.E6_COLUMNS))
    assert "No E6 results yet" in e6.report(d)
