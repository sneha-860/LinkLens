"""make_all: every RQ table (CSV + LaTeX) and figure (PDF + PNG) from one batch export, and the
results README that maps each to its RQ and experiment."""

import json
import shutil
from pathlib import Path

import pandas as pd
import pytest

from linklens_analysis import make_all as mk
from linklens_analysis.__main__ import main as cli
from linklens_analysis.latex import cell, escape, to_latex
from plotting import MATPLOTLIB_ERROR, needs_matplotlib

FIXTURES = Path(__file__).parent / "fixtures"


def batch_copy(tmp_path: Path, rename_class: bool = True) -> Path:
    """The integration test's export, its class "docs" renamed to a class with a validated
    colour (the figures refuse an unknown class)."""
    d = tmp_path / "batch"
    shutil.copytree(FIXTURES / "corpus-export", d)
    if rename_class:
        for f in d.glob("*.csv"):
            df = pd.read_csv(f, dtype=str, keep_default_na=False)
            if "architecture_class" in df:
                df["architecture_class"] = df["architecture_class"].replace("docs", "documentation")
                df.to_csv(f, index=False, lineterminator="\n")
    return d


def test_every_artifact_has_a_known_rq_and_a_unique_id():
    ids = [a.id for a in mk.ARTIFACTS]
    assert len(ids) == len(set(ids))
    rqs = {rq.id: rq for rq in mk.RQS}
    for a in mk.ARTIFACTS:
        assert a.rq in rqs, a.id
        assert a.experiment in rqs[a.rq].experiments, a.id
        assert a.kind in ("table", "figure")
        assert a.id.startswith(("t" if a.kind == "table" else "f") + a.rq[2:]), a.id
    # RQ1–RQ5 each have at least one table and one figure.
    for rq in ("RQ1", "RQ2", "RQ3", "RQ4", "RQ5"):
        kinds = {a.kind for a in mk.ARTIFACTS if a.rq == rq}
        assert kinds == {"table", "figure"}, rq


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    """One make_all run shared by the tests that only read its output."""
    tmp = tmp_path_factory.mktemp("make_all")
    batch = batch_copy(tmp)
    out = tmp / "out"
    return batch, out, mk.make_all(batch, out)


def test_tables_and_readme(made):
    _, out, outcomes = made
    by_id = {o.artifact.id: o for o in outcomes}
    assert set(by_id) == {a.id for a in mk.ARTIFACTS}
    for a in mk.ARTIFACTS:
        o = by_id[a.id]
        if a.kind != "table" or o.skipped:
            continue
        csv = out / "tables" / f"{a.id}.csv"
        tex = (out / "tables" / f"{a.id}.tex").read_text(encoding="utf-8")
        assert not pd.read_csv(csv).empty, a.id
        assert rf"\label{{tab:{a.id}}}" in tex and r"\toprule" in tex and tex.endswith("\\end{table}\n")
        assert "σ" not in tex and "Δ" not in tex and "ε" not in tex, a.id  # all as math
    # The fixture has no large Screaming Frog disagreement: that table is skipped, with why.
    assert by_id["t4_e5_large_categories"].skipped
    assert by_id["t1_e1_summary"].skipped is None

    readme = (out / "README.md").read_text(encoding="utf-8")
    for a in mk.ARTIFACTS:
        assert f"| `{a.id}` | {a.rq} | {a.experiment} | {a.kind} |" in readme
    for rq in mk.RQS:
        assert f"## {rq.id}: {rq.title}" in readme
    assert "**Headline (C5):**" in readme
    assert "- `t4_e5_large_categories`:" in readme.split("## Skipped")[1]
    # A pipe in a title must not split the Markdown table.
    for line in readme.split("## Map")[1].split("\n## ")[0].strip().splitlines()[2:]:
        assert line.replace(r"\|", "").count("|") == 7, line

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert set(manifest["inputs"]) >= {"sites.csv", "e3.csv", "e6.csv", "e7.csv"}
    assert [m["id"] for m in manifest["artifacts"]] == [a.id for a in mk.ARTIFACTS]


def test_output_is_deterministic(made, tmp_path):
    batch, first, _ = made
    mk.make_all(batch, tmp_path / "b")
    for f in sorted(first.rglob("*")):
        if f.suffix in (".csv", ".tex", ".md"):
            twin = tmp_path / "b" / f.relative_to(first)
            assert f.read_bytes() == twin.read_bytes(), f.name


def test_missing_experiments_are_skipped_not_fatal_through_the_cli(tmp_path, capsys):
    """No re-crawl and no Screaming Frog import yet: the export writes those CSVs header-only."""
    batch = batch_copy(tmp_path)
    for name in ("e4.csv", "e4_pages.csv", "e5.csv", "e5_categories.csv", "e5_disagreements.csv"):
        f = batch / name
        f.write_text(f.read_text(encoding="utf-8").splitlines()[0] + "\n", encoding="utf-8")
    assert cli(["make-all", str(batch), "--out", str(tmp_path / "out"), "--k", "10"]) == 0
    captured = capsys.readouterr()
    assert "outputs written to" in captured.out and "skipped t4_e4_summary" in captured.err
    manifest = json.loads((tmp_path / "out" / "manifest.json").read_text(encoding="utf-8"))
    skipped = {m["id"] for m in manifest["artifacts"] if m["skipped"]}
    rq4 = {a.id for a in mk.ARTIFACTS if a.rq == "RQ4"}
    assert rq4 <= skipped
    assert "t3_e3_paired_raw" not in skipped
    readme = (tmp_path / "out" / "README.md").read_text(encoding="utf-8")
    assert "t4_e4_summary" in readme.split("## Skipped")[1]


@needs_matplotlib
def test_figures_pdf_png_and_snippet(made):
    _, out, outcomes = made
    figures = [o for o in outcomes if o.artifact.kind == "figure"]
    assert all(o.skipped is None for o in figures), [(o.artifact.id, o.skipped) for o in figures if o.skipped]
    for o in figures:
        for ext in ("pdf", "png"):
            assert (out / "figures" / f"{o.artifact.id}.{ext}").stat().st_size > 1000
        snippet = (out / "figures" / f"{o.artifact.id}.tex").read_text(encoding="utf-8")
        assert rf"\includegraphics[width=\linewidth]{{figures/{o.artifact.id}.pdf}}" in snippet


@needs_matplotlib
def test_unknown_class_skips_the_class_coloured_figure(tmp_path):
    outcomes = mk.make_all(batch_copy(tmp_path, rename_class=False), tmp_path / "out")
    o = next(o for o in outcomes if o.artifact.id == "f3_e3_paired")
    assert o.skipped and "'docs'" in o.skipped


@pytest.mark.skipif(MATPLOTLIB_ERROR is None, reason="matplotlib loads here")
def test_figures_are_skipped_without_matplotlib(made):
    _, _, outcomes = made
    assert all(o.skipped for o in outcomes if o.artifact.kind == "figure")


def test_latex_escaping():
    assert escape("50% of a_b & c#1 {x} ~ ^ \\ $") == (
        r"50\% of a\_b \& c\#1 \{x\} \textasciitilde{} \textasciicircum{} \textbackslash{} \$"
    )
    assert escape("σ ≥ ε, Δ|x| < α") == r"$\sigma$ $\geq$ $\varepsilon$, $\Delta$\textbar{}x\textbar{} \textless{} $\alpha$"
    assert escape("ε²") == r"$\varepsilon$$^2$"
    assert cell(float("nan")) == "--" and cell(None) == "--"
    assert cell(True) == "yes" and cell(0.123456) == "0.123" and cell(1234567.0) == "1.23e+06"


def test_to_latex_alignment_index_and_width():
    df = pd.DataFrame({"class": ["a", "b"], "n": [1, 2], "p": [0.5, float("nan")]}).set_index("class")
    tex = to_latex(df, "Caption with σ", "tab:x")
    assert r"\begin{tabular}{lrr}" in tex
    assert r"class & n & p \\" in tex
    assert r"a & 1 & 0.5 \\" in tex and r"b & 2 & -- \\" in tex
    assert r"\caption{Caption with $\sigma$}" in tex
    assert "resizebox" not in tex
    wide = to_latex(pd.DataFrame([list(range(10))]), "Wide", "tab:w")
    assert r"\resizebox{\linewidth}{!}{%" in wide and "\\end{tabular}}\n\\end{table}" in wide
