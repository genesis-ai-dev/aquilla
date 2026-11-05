"""Biblica QA skills runner over the Aquilla Agent API (AQU-2365).

The 13 skill files in `../skills/` are the specification; this package is the
harness that honours them against a live project. See `../README.md` for how an
operator runs it, and `stage.py` for the one rule the whole thing exists to
keep: findings are proposals a person approves, never edits.
"""

__all__ = ["api", "baseline", "bootstrap", "cli", "corpus", "findings", "qa_run", "reader", "report", "scope", "stage"]
