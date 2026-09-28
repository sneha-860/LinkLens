"""Regenerate every table (LaTeX + CSV) and figure (PDF + PNG) for RQ1–RQ5 in one command.

    python make_all.py <batch dir> [--out <dir>] [--k 10] [--alpha 0.05]

See linklens_analysis/make_all.py (the RQ → experiment mapping is RQS there).
"""

from linklens_analysis.make_all import main

if __name__ == "__main__":
    raise SystemExit(main())
