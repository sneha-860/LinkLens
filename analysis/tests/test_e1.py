"""E1 across the corpus: every pair of policies per site (policy_pairs.csv)."""

from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from linklens_analysis import corpus, e1, results, style
from linklens_analysis.__main__ import main
from plotting import needs_matplotlib

FIXTURES = Path(__file__).parent / "fixtures"
POLICIES = list(style.POLICIES)
PAIRS = list(combinations(POLICIES, 2))


def synthetic_pairs(sites_per_class: int = 4, seed: int = 42) -> pd.DataFrame:
    """Agreement falls with the distance between policies; documentation sites are the most
    sensitive; one blog site has no ranking under P5 (its fix Jaccards are undefined)."""
    rng = np.random.default_rng(seed)
    rows = []
    for cls, sensitivity in [("cms-blog", 0.03), ("ecommerce-catalogue", 0.06), ("documentation", 0.12)]:
        for i in range(sites_per_class):
            site = f"{cls[:4]}-{i}"
            nodes = {p: 500 * (1 - sensitivity) ** k for k, p in enumerate(POLICIES)}
            for a, b in PAIRS:
                gap = POLICIES.index(b) - POLICIES.index(a)
                noise = rng.normal(0, 0.005)
                values = {
                    "nodes_a": round(nodes[a]),
                    "nodes_b": round(nodes[b]),
                    "orphan_jaccard": max(0.0, 1 - sensitivity * gap + noise),
                    "pagerank_spearman": 1 - sensitivity * gap / 2 + noise,
                    "mean_depth_shift": -sensitivity * gap * 3,
                    "max_abs_depth_shift": float(gap),
                    "top_fixes_jaccard": max(0.0, 1 - 2 * sensitivity * gap),
                }
                if site == "cms--0" and b == "P5":
                    del values["top_fixes_jaccard"]
                for metric, value in values.items():
                    rows.append(
                        {
                            "batch_id": "syn",
                            "site_id": site,
                            "architecture_class": cls,
                            "run_id": 1,
                            "policy_a": a,
                            "policy_b": b,
                            "top_k": 10,
                            "metric": metric,
                            "value": value,
                        }
                    )
    return pd.DataFrame(rows, columns=corpus.POLICY_PAIRS_COLUMNS)


@pytest.fixture()
def pairs() -> pd.DataFrame:
    return synthetic_pairs()


def test_loads_the_real_export():
    b = corpus.load_batch(FIXTURES / "corpus-export")
    p = b.pairs
    assert p.groupby(["policy_a", "policy_b"], observed=True).ngroups == 15
    assert (p["top_k"] == 10).all()
    got = p[(p["policy_a"] == "P3") & (p["policy_b"] == "P4") & (p["metric"] == "top_fixes_jaccard")]
    assert got["value"].tolist() == [1.0]
    # Only P3 and P4 were ranked in the fixture run: that is the only defined fix Jaccard.
    assert (p["metric"] == "top_fixes_jaccard").sum() == 1
    s = e1.class_summary(p)
    assert s.loc[("docs", "orphan_jaccard"), "sites"] == 1


def test_rejects_pairs_out_of_order(tmp_path):
    d = tmp_path / "b"
    d.mkdir()
    for name in ("metrics.csv", "channels.csv", "e3.csv", "e4.csv", "e4_pages.csv", "e5.csv", "e5_categories.csv", "e5_disagreements.csv", "e6.csv", "sites.csv", "stages.csv"):
        (d / name).write_bytes((FIXTURES / "corpus-export" / name).read_bytes())
    bad = synthetic_pairs(1)
    bad.loc[0, ["policy_a", "policy_b"]] = ["P1", "P0"]
    bad.to_csv(d / "policy_pairs.csv", index=False)
    with pytest.raises(ValueError, match="P0–P5 order"):
        corpus.load_batch(d)


def test_node_count_ratio_is_symmetric_min_over_max(pairs):
    long = e1.pairs_long(pairs)
    r = long[(long["metric"] == "node_count_ratio") & (long["site_id"] == "docu-0")]
    assert len(r) == 15
    p0_p1 = r[(r["policy_a"] == "P0") & (r["policy_b"] == "P1")]["value"].item()
    assert p0_p1 == pytest.approx(round(500 * 0.88) / 500)
    assert ((r["value"] > 0) & (r["value"] <= 1)).all()


def test_class_summary(pairs):
    s = e1.class_summary(pairs)
    classes = s.index.get_level_values("architecture_class").unique().tolist()
    assert classes == [*style.CLASSES, e1.ALL]  # fixed order, then all sites
    assert s.loc[("cms-blog", "orphan_jaccard"), "sites"] == 4
    assert s.loc[(e1.ALL, "orphan_jaccard"), "sites"] == 12
    # More sensitive classes agree less.
    med = s.xs("pagerank_spearman", level="metric")["median"]
    assert med["cms-blog"] > med["ecommerce-catalogue"] > med["documentation"]
    # The least-agreeing pair is the most distant one; for depth, the largest |shift|.
    assert s.loc[("documentation", "orphan_jaccard"), "worst_pair"] == "P0–P5"
    assert s.loc[("documentation", "mean_depth_shift"), "worst_pair"] == "P0–P5"
    assert s.loc[("documentation", "mean_depth_shift"), "worst_value"] == pytest.approx(-1.8)
    # A site without some fix Jaccards still counts, over the pairs it has.
    assert s.loc[("cms-blog", "top_fixes_jaccard"), "sites"] == 4
    assert (s["q1"] <= s["median"]).all() and (s["median"] <= s["q3"]).all()

    wide = e1.summary_wide(s)
    assert list(wide.index) == [*style.CLASSES, e1.ALL]
    assert list(wide.columns) == ["sites", *[m.name for m in e1.METRICS]]
    assert wide.loc["cms-blog", "sites"] == 4
    assert "[" in wide.loc["documentation", "orphan_jaccard"]


def test_agreement_matrix_is_lower_triangular_row_minus_column(pairs):
    m = e1.agreement_matrix(pairs, "mean_depth_shift", "documentation")
    assert list(m.index) == ["P1", "P2", "P3", "P4", "P5"]
    assert list(m.columns) == ["P0", "P1", "P2", "P3", "P4"]
    values = m.to_numpy()
    assert np.isnan(values[np.triu_indices(5, k=1)]).all()
    assert not np.isnan(values[np.tril_indices(5)]).any()
    # Cell (P5, P0) is the pair (P0, P5): b − a = 5 steps coarser.
    assert m.loc["P5", "P0"] == pytest.approx(-0.12 * 5 * 3)
    assert m.loc["P1", "P0"] == pytest.approx(-0.12 * 3)
    everyone = e1.agreement_matrix(pairs, "orphan_jaccard")
    assert everyone.loc["P1", "P0"] > everyone.loc["P5", "P0"]
    # The site without a P5 ranking: the other sites still give P5 cells a median.
    assert not np.isnan(e1.agreement_matrix(pairs, "top_fixes_jaccard", "cms-blog").loc["P5", "P0"])


def test_agreement_matrix_leaves_undefined_pairs_empty():
    only = synthetic_pairs(1)
    only = only[~((only["metric"] == "top_fixes_jaccard") & (only["policy_b"] == "P5"))]
    m = e1.agreement_matrix(only, "top_fixes_jaccard")
    assert np.isnan(m.loc["P5"]).all()
    assert not np.isnan(m.loc["P4", "P0"])


def test_single_run_e1_has_a_pairs_table():
    data = results.load(FIXTURES / "E1.json")
    tables = dict(results.tables(data))
    t = tables["Policy pairs"]
    assert len(t) == 15 and t.index[0] == "P0–P1"
    assert t.loc["P3–P4", "topFixesJaccard"] == 1


def write_batch(tmp_path: Path, pairs: pd.DataFrame) -> Path:
    d = tmp_path / "batch"
    d.mkdir()
    for name in ("metrics.csv", "channels.csv", "e3.csv", "e4.csv", "e4_pages.csv", "e5.csv", "e5_categories.csv", "e5_disagreements.csv", "e6.csv", "sites.csv", "stages.csv"):
        (d / name).write_bytes((FIXTURES / "corpus-export" / name).read_bytes())
    pairs.to_csv(d / "policy_pairs.csv", index=False)
    return d


def test_report_and_cli(tmp_path, pairs, capsys):
    d = write_batch(tmp_path, pairs)
    md = e1.report(d)
    assert "## E1 policy sensitivity" in md
    assert "| documentation" in md and "| all sites" in md
    assert "Top-k fix list Jaccard: all sites" in md
    assert main(["e1", str(d)]) == 0
    assert "Least-agreeing pair" in capsys.readouterr().out


@needs_matplotlib
def test_heatmaps(tmp_path, pairs):
    written = e1.figures(pairs, tmp_path / "fig")
    assert sorted(p.name for p in written) == sorted(
        f"e1_{m.name}.{ext}" for m in e1.METRICS for ext in ("pdf", "png")
    )
    assert all(p.stat().st_size > 0 for p in written)
    none = pairs[pairs["metric"] != "top_fixes_jaccard"]
    assert not any("top_fixes" in p.name for p in e1.figures(none, tmp_path / "fig2"))


@needs_matplotlib
def test_cli_heatmaps(tmp_path, pairs):
    d = write_batch(tmp_path, pairs)
    assert main(["e1", str(d), "--stat", "mean", "--figures", str(tmp_path / "f")]) == 0
    assert (tmp_path / "f" / "e1_orphan_jaccard.pdf").exists()
