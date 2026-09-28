"""The analysis reads the eval package's real output: the fixtures are written by
`LINKLENS_WRITE_FIXTURES=1 pnpm --filter @linklens/eval test:integration`."""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from linklens_analysis import results
from linklens_analysis.__main__ import main

FIXTURES = Path(__file__).parent / "fixtures"
ALL = [f"E{i}" for i in range(1, 9)]


def fixture(name: str) -> dict:
    return results.load(FIXTURES / f"{name}.json")


@pytest.mark.parametrize("name", ALL)
def test_every_experiment_turns_into_tables(name):
    data = fixture(name)
    assert data["experiment"] == name
    tables = results.tables(data)
    assert tables
    for title, df in tables:
        assert isinstance(title, str) and title
        assert isinstance(df, pd.DataFrame) and not df.empty


def test_e1_has_a_row_per_policy_and_the_baseline_against_itself():
    df = results.e1_table(fixture("E1")["result"])
    assert list(df.index) == ["P0", "P1", "P2", "P3", "P4", "P5"]
    assert df.loc["P3", "pagerankSpearman"] == pytest.approx(1)
    assert df.loc["P3", "meanDepthShift"] == pytest.approx(0)


def test_e3_table_has_every_k_and_method():
    data = fixture("E3")["result"]
    df = results.e3_table(data)
    assert list(df.index.get_level_values("k").unique()) == [10, 25, 50]
    assert list(df.loc[10].index) == ["linklens", "random", "highestCosine", "highestPagerank"]
    # The fixture's pool (2 fixes) is smaller than every k: all methods apply all of it.
    assert df["total ΔPR"].nunique() == 1 or np.allclose(df["total ΔPR"], df["total ΔPR"].iloc[0])
    pool = results.e3_pool_table(data)
    assert pool.loc["orphans", "value"] == 1


def test_e7_tables_have_every_sigma():
    tables = dict(results.tables(fixture("E7")))
    assert set(tables["σ ablation"].index) == {"refGateCosine", "cosineOnly", "refOnly", "blended"}
    assert len(tables["σ pairs"]) == 6


def test_bootstrap_is_seeded_and_brackets_the_mean():
    values = np.array([0.0, 0.5, 1.0, 1.0, 0.25])
    lo, hi = results.bootstrap_ci(values)
    assert lo <= values.mean() <= hi
    assert results.bootstrap_ci(values) == (lo, hi)
    assert all(np.isnan(results.bootstrap_ci(np.array([]))))


def test_rejects_files_that_are_not_results(tmp_path):
    bad = tmp_path / "x.json"
    bad.write_text('{"hello": 1}', encoding="utf-8")
    with pytest.raises(ValueError):
        results.load(bad)


def test_report_command_prints_markdown(capsys):
    assert main(["report", str(FIXTURES / "E2.json"), str(FIXTURES / "E6.json")]) == 0
    out = capsys.readouterr().out
    assert "## E2 (E2.json)" in out and "## E6 (E6.json)" in out
    assert "| channel" in out
    assert main([]) == 2
