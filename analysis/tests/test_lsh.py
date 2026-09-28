"""The LSH Ensemble pre-filter experiment (lsh.csv / lsh.json of `lsh run`), on a fixture written
by the eval unit test (LINKLENS_WRITE_FIXTURES=1): two sites, caps 6/12/18."""

from pathlib import Path

import numpy as np
import pytest

from linklens_analysis import lsh
from linklens_analysis.__main__ import main
from plotting import needs_matplotlib

FIXTURE = Path(__file__).parent / "fixtures" / "lsh"


@pytest.fixture(scope="module")
def data():
    return lsh.load(FIXTURE)


def test_load_checks_columns(tmp_path, data):
    df, meta = data
    assert set(df["site_id"]) == {"ocean", "reef"}
    assert sorted(df["cap"].unique()) == [6, 12, 18]
    assert lsh.default_threshold(df, meta) == 0.1
    df.drop(columns=["metric"]).to_csv(tmp_path / "lsh.csv", index=False)
    with pytest.raises(ValueError, match="metric"):
        lsh.load(tmp_path)


def test_summary_table(data):
    df, meta = data
    t = lsh.summary_table(df, 0.1)
    assert list(t.index.names) == ["site", "cap"]
    assert len(t) == 6
    for col in ["recall", "REF-mass recall", "top-30 recall", "precision"]:
        assert t[col].between(0, 1).all(), col
    assert (t["candidates (% of pairs)"] <= 100).all()
    # Speed-ups are the runtime ratios.
    np.testing.assert_allclose(t["speed-up vs exact"], t["exact (s)"] / t["LSH (s)"])
    np.testing.assert_allclose(t["speed-up vs brute force"], t["brute force (s)"] / t["LSH (s)"])
    assert "t* = 0.1" in t.attrs["setting"]
    # The unweighted variant is summarised against its own truth.
    u = lsh.summary_table(df, 0.1, "unweighted")
    assert len(u) == 6 and (u["true pairs"] > 0).all()


def test_threshold_table_is_monotone_in_candidates(data):
    df, _ = data
    t = lsh.threshold_table(df)
    assert (t["sites"] == 2).all()
    # A lower containment threshold returns at least as many candidates on the same index.
    for cap, g in t.groupby(level="cap"):
        shares = g["candidates (share)"].to_numpy()
        assert (np.diff(shares) <= 1e-12).all(), cap


def test_report_and_cli(capsys):
    text = lsh.report(FIXTURE)
    assert "Per site and page cap" in text and "threshold trade-off" in text
    assert main(["lsh", str(FIXTURE)]) == 0
    assert "LSH Ensemble REF pre-filter" in capsys.readouterr().out


@needs_matplotlib
def test_figure(tmp_path):
    written = lsh.figures(FIXTURE, tmp_path)
    assert {p.suffix for p in written} == {".pdf", ".png"}
    assert all(p.stat().st_size > 1000 for p in written)


def test_missing_brute_force_is_allowed(tmp_path, data):
    df, meta = data
    df[df["metric"] != "ms_brute_force"].to_csv(tmp_path / "lsh.csv", index=False)
    t = lsh.summary_table(lsh.load(tmp_path)[0], 0.1)
    assert t["brute force (s)"].isna().all()
    assert t["speed-up vs exact"].notna().all()
