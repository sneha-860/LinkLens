"""Figure tests need matplotlib's compiled extensions, which some machines block (e.g. a
Windows Application Control policy): those tests are skipped there, with the reason."""

import pytest


def _matplotlib_error() -> str | None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot  # noqa: F401  (loads the compiled extensions)
    except Exception as e:  # ImportError, or a half-initialised module after one
        return f"matplotlib cannot load here: {type(e).__name__}: {e}"
    return None


MATPLOTLIB_ERROR = _matplotlib_error()
needs_matplotlib = pytest.mark.skipif(MATPLOTLIB_ERROR is not None, reason=MATPLOTLIB_ERROR or "")
