"""python -m linklens_analysis report results/*.json  →  Markdown tables on stdout."""

import sys

from .results import report


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] != "report":
        print("usage: python -m linklens_analysis report <result.json>…", file=sys.stderr)
        return 2
    print(report(argv[1:]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
