import pytest

from linklens_analysis import style

from plotting import needs_matplotlib


def luminance(hex_colour: str) -> float:
    r, g, b = (int(hex_colour[i : i + 2], 16) / 255 for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def test_every_class_has_a_distinct_colour_and_marker():
    assert set(style.CLASS_COLOURS) == set(style.CLASSES) == set(style.CLASS_MARKERS)
    assert len(set(style.CLASS_COLOURS.values())) == len(style.CLASSES)
    assert len(set(style.CLASS_MARKERS.values())) == len(style.CLASSES)


def test_policy_ramp_gets_darker():
    lum = [luminance(style.POLICY_COLOURS[p]) for p in style.POLICIES]
    assert lum == sorted(lum, reverse=True)


def test_unknown_class_is_an_error_not_a_new_hue():
    with pytest.raises(KeyError, match="re-validate"):
        style.class_colour("wiki")
    assert style.ordered_classes(["zeta", "documentation", "cms-blog"]) == [
        "cms-blog",
        "documentation",
        "zeta",
    ]


@needs_matplotlib
def test_style_is_scoped_and_saves_pdf_and_png(tmp_path):
    import matplotlib as mpl
    import matplotlib.pyplot as plt

    before = mpl.rcParams["axes.spines.top"]
    with style.style():
        assert mpl.rcParams["axes.spines.top"] is False
        fig, ax = plt.subplots()
        ax.plot([0, 1], [0, 1])
        paths = style.save(fig, tmp_path / "x" / "line")
        plt.close(fig)
    assert mpl.rcParams["axes.spines.top"] == before
    assert [p.name for p in paths] == ["line.pdf", "line.png"]
    assert all(p.stat().st_size > 0 for p in paths)
