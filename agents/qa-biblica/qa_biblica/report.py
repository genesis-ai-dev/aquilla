"""The `qa-run-book.md` report, rendered exactly as that file specifies.

Two things ride along with the prose, both required by the issue:

* **Provenance.** The header states the API snapshot time and the baseline date,
  so a reader can tell what the run actually saw.
* **Fingerprints.** The footer carries every finding's fingerprint in an HTML
  comment. A later run reads its own previous report back off the cell
  (`GET …/comments`) and drops findings already reported — which is what makes
  re-running the same scope with no changes produce no new findings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from .findings import Finding, Severity, tally

#: skill → pass label, for the summary table's rows (qa-run-book.md → Order).
PASS_OF_SKILL: dict[str, str] = {
    "qa-chapter-verse": "1 Mechanical",
    "qa-text-integrity": "1 Mechanical",
    "qa-characters-punctuation": "1 Mechanical",
    "qa-capitalization-numbers": "1 Mechanical",
    "qa-spelling-wordlist": "2 Spelling",
    "qa-key-terms-names": "3 Consistency",
    "qa-parallel-passages": "3 Consistency",
    "qa-meaning-fidelity": "4 Meaning",
    "qa-notes-headings-names": "5 Publish",
    "qa-publish-readiness": "5 Publish",
}

PASS_ORDER: tuple[str, ...] = (
    "1 Mechanical",
    "2 Spelling",
    "3 Consistency",
    "4 Meaning",
    "5 Publish",
)

_FINGERPRINT_RE = re.compile(r"qa-biblica:([0-9a-f]{16})")
_MARKER = "qa-biblica-report"


@dataclass
class Report:
    scope: str
    source_text: str
    run_date: str
    snapshot_at: str
    baseline_verified: str
    findings: list[Finding] = field(default_factory=list)
    not_checked: list[str] = field(default_factory=list)
    code_log: list[str] = field(default_factory=list)
    #: Fingerprints carried by a previous report on the same cell.
    previously_reported: frozenset[str] = frozenset()

    @property
    def gate_ready(self) -> bool:
        counts = tally(self.findings)
        return counts[Severity.CRITICAL] == 0 and counts[Severity.MAJOR] == 0

    def render(self) -> str:
        return "\n".join(
            [
                f"# QA report — {self.scope} — {self.run_date}",
                f"Source text: {self.source_text or '(not named in the brief)'}   "
                f"Baseline: verified {self.baseline_verified or '(not recorded)'}",
                f"API snapshot: {self.snapshot_at}",
                "",
                self._summary(),
                "",
                self._findings_table(),
                "",
                self._not_checked(),
                "",
                self._code_block(),
                "",
                self._fingerprints(),
            ]
        )

    # -- sections ---------------------------------------------------------

    def _summary(self) -> str:
        lines = [
            "## Summary",
            "| Pass | Critical | Major | Minor | Query |",
            "|------|---------:|------:|------:|------:|",
        ]
        for pass_label in PASS_ORDER:
            in_pass = [f for f in self.findings if PASS_OF_SKILL.get(f.skill) == pass_label]
            if not in_pass:
                continue
            counts = tally(in_pass)
            lines.append(
                f"| {pass_label} | {counts[Severity.CRITICAL]} | {counts[Severity.MAJOR]} "
                f"| {counts[Severity.MINOR]} | {counts[Severity.QUERY]} |"
            )
        totals = tally(self.findings)
        lines.append(
            f"| **Total** | **{totals[Severity.CRITICAL]}** | **{totals[Severity.MAJOR]}** "
            f"| **{totals[Severity.MINOR]}** | **{totals[Severity.QUERY]}** |"
        )
        status = "READY" if self.gate_ready else "NOT READY"
        lines.append("")
        lines.append(
            f"Gate status: {status} ({totals[Severity.CRITICAL]} Critical open, "
            f"{totals[Severity.MAJOR]} Major open)"
        )
        return "\n".join(lines)

    def _findings_table(self) -> str:
        lines = [
            "## Findings (grouped; sorted Critical → Query, then by number of verses)",
            "| # | Refs | Skill | Severity | Confidence | Found | Baseline / evidence | Proposed fix | Verifier |",
            "|---|------|-------|----------|------------|-------|---------------------|--------------|----------|",
        ]
        if not self.findings:
            lines.append("| — | — | — | — | — | No deviations from the verified baseline | — | — | — |")
            return "\n".join(lines)
        for number, finding in enumerate(self.findings, start=1):
            lines.append(
                "| {n} | {refs} | {skill} | {sev} | {conf} | {found} | {evidence} | {fix} | {verifier} |".format(
                    n=number,
                    refs=_cell(finding.ref_summary),
                    skill=_cell(finding.skill),
                    sev=finding.severity.value,
                    conf=finding.confidence.value,
                    found=_cell(finding.found),
                    evidence=_cell(finding.evidence),
                    fix=_cell(finding.proposed_fix),
                    verifier=finding.verifier.value,
                )
            )
        return "\n".join(lines)

    def _not_checked(self) -> str:
        lines = ["## Not checked"]
        if not self.not_checked:
            lines.append("Nothing was skipped.")
        else:
            lines.extend(f"- {entry}" for entry in self.not_checked)
        return "\n".join(lines)

    def _code_block(self) -> str:
        if not self.code_log:
            return ""
        return "\n".join(
            [
                "<details><summary>Code output (every count above came from this)</summary>",
                "",
                "```",
                *self.code_log,
                "```",
                "",
                "</details>",
            ]
        )

    def _fingerprints(self) -> str:
        """Machine-readable footer for the next run's idempotency check."""
        marks = " ".join(f"qa-biblica:{f.fingerprint}" for f in self.findings)
        return f"<!-- {_MARKER} {marks} -->"


def _cell(text: str) -> str:
    """Make a value safe for a Markdown table cell."""
    return (text or "—").replace("|", "\\|").replace("\n", " ").strip() or "—"


def previous_fingerprints(comments: Iterable[dict]) -> frozenset[str]:
    """Fingerprints this runner already reported, read off prior comments.

    Both the report footer and the per-finding comments carry them, so a finding
    counts as already-reported whichever way it was staged.
    """
    found: set[str] = set()
    for comment in comments:
        body = str(comment.get("body") or "")
        if "qa-biblica:" not in body:
            continue
        found.update(_FINGERPRINT_RE.findall(body))
    return frozenset(found)


def drop_already_reported(
    findings: Sequence[Finding], previous: frozenset[str]
) -> tuple[list[Finding], int]:
    """Filter out findings a previous run already reported on this scope.

    Returns the kept findings and how many were suppressed, so the run log can
    say "12 findings, 12 already reported, 0 new" instead of looking like it
    found nothing.
    """
    if not previous:
        return list(findings), 0
    kept = [f for f in findings if f.fingerprint not in previous]
    return kept, len(findings) - len(kept)
