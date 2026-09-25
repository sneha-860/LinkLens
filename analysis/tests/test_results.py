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


def test_e3_paired_tests_compare_linklens_with_every_baseline():
    df = results.e3_paired_tests(fixture("E3")["result"])
    assert set(df.index) == {"refOnly", "highestPagerank", "random", "sameSectionRandom", "homePage", "oracle"}
    # The oracle is the best ΔPR by definition: LinkLens is never better than it.
    assert df.loc["oracle", "LinkLens better"] == 0
    assert (df["targets"] > 0).any()


def test_recovery_tables_have_mrr_with_a_confidence_interval():
    df = results.recovery_table(fixture("E7")["result"])
    assert set(df.index) == {"refGateCosine", "cosineOnly", "refOnly", "blended"}
    assert {"MRR", "MRR 95% CI", "recall@1", "recall@10"} <= set(df.columns)
    pairs = results.sigma_paired_tests(fixture("E7")["result"])
    assert len(pairs) == 6


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
