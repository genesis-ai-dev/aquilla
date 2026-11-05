"""Finding model shared by every QA pass (AQU-2365).

The shape is dictated by `skills/qa-run-book.md`: every finding carries Ref,
Check, Severity, Confidence, Evidence, Proposed fix and Verifier. Two of that
file's rules are *invariants* rather than guidance, so they are enforced here
instead of being left to each checker to remember:

1. **"Low confidence is always a Query."** A `Finding` built with
   `Confidence.LOW` and any other severity is rejected at construction.
2. **"High = verified by code."**  `Confidence.HIGH` is only reachable from a
   finding whose `produced_by` is `CODE`. A model-produced finding is capped at
   Medium, which is what keeps the determinism promise in the issue honest:
   nothing the model wrote can claim code-grade confidence.

Grouping ("group identical issues into one finding with all references") is a
pure function over a list of findings, so the orchestrator can merge the output
of several passes without any checker knowing about the others.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Iterable, Sequence


class Severity(str, Enum):
    CRITICAL = "Critical"
    MAJOR = "Major"
    MINOR = "Minor"
    QUERY = "Query"


class Confidence(str, Enum):
    HIGH = "High"
    MEDIUM = "Medium"
    LOW = "Low"


class Verifier(str, Enum):
    POST_EDITOR = "Post-editor"
    PROOF_READER = "Proof-reader"
    MENTOR = "Mentor"


class ProducedBy(str, Enum):
    CODE = "code"
    MODEL = "model"


#: Sort order for the report's findings table: Critical → Query.
SEVERITY_ORDER: dict[Severity, int] = {
    Severity.CRITICAL: 0,
    Severity.MAJOR: 1,
    Severity.MINOR: 2,
    Severity.QUERY: 3,
}


class FindingRuleError(ValueError):
    """A finding was built in a way qa-run-book.md forbids."""


@dataclass(frozen=True)
class Finding:
    """One QA finding, already grouped across however many verses it spans."""

    skill: str
    check: str
    severity: Severity
    confidence: Confidence
    #: Human-readable refs ("MRK 1:3"), in canonical order. May be empty for a
    #: book-level finding (e.g. "chapter count differs from the source").
    refs: tuple[str, ...] = ()
    #: Cell ids behind `refs`, same order, used to anchor per-finding comments.
    cell_ids: tuple[str, ...] = ()
    #: File of the first ref. A per-finding comment needs it: `comment.create`
    #: with a cellId and no fileId silently demotes to a project comment
    #: (sync-worker/src/external/commands-emit-events.ts).
    file_id: str = ""
    #: What the pass actually saw.
    found: str = ""
    #: What the verified baseline says, or the code evidence for the claim.
    evidence: str = ""
    proposed_fix: str = ""
    verifier: Verifier = Verifier.PROOF_READER
    produced_by: ProducedBy = ProducedBy.CODE

    def __post_init__(self) -> None:
        if self.confidence is Confidence.LOW and self.severity is not Severity.QUERY:
            raise FindingRuleError(
                f"{self.skill}/{self.check}: Low confidence is always a Query "
                f"(qa-run-book.md → Severity), got {self.severity.value}"
            )
        if self.confidence is Confidence.HIGH and self.produced_by is not ProducedBy.CODE:
            raise FindingRuleError(
                f"{self.skill}/{self.check}: High confidence means 'verified by code'; "
                "a model-produced finding is Medium at best"
            )
        if len(self.cell_ids) not in (0, len(self.refs)):
            raise FindingRuleError(
                f"{self.skill}/{self.check}: cell_ids must be empty or parallel to refs"
            )

    # -- identity ---------------------------------------------------------

    @property
    def group_key(self) -> tuple[str, str, str, str, str, str]:
        """Two findings with the same key are 'the same issue' and merge."""
        return (
            self.skill,
            self.check,
            self.severity.value,
            self.found,
            self.evidence,
            self.proposed_fix,
        )

    @property
    def fingerprint(self) -> str:
        """Stable id for idempotency: equal across runs when nothing changed.

        Deliberately includes the refs — the same check failing on a *different*
        verse is a new finding — and deliberately excludes the proposed fix's
        wording, so a reworded suggestion does not re-report an open issue.
        """
        material = "\u001f".join(
            (self.skill, self.check, self.severity.value, self.found, *sorted(self.refs))
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]

    @property
    def ref_summary(self) -> str:
        """Refs for the table cell: all of them up to 5, then '+N more'."""
        if not self.refs:
            return "(book)"
        if len(self.refs) <= 5:
            return "; ".join(self.refs)
        return "; ".join(self.refs[:5]) + f" +{len(self.refs) - 5} more"


@dataclass
class FindingSet:
    """Accumulator a checker fills, so checkers never sort or merge."""

    skill: str
    findings: list[Finding] = field(default_factory=list)
    #: Lines of code-output evidence shown in the report's collapsed block.
    code_log: list[str] = field(default_factory=list)
    #: Checks this pass deliberately did not run, and why — feeds "Not checked".
    not_checked: list[str] = field(default_factory=list)

    def add(self, finding: Finding) -> None:
        self.findings.append(finding)

    def log(self, line: str) -> None:
        self.code_log.append(line)

    def skip(self, check: str, reason: str) -> None:
        self.not_checked.append(f"{self.skill} / {check}: {reason}")


def merge(findings: Iterable[Finding]) -> list[Finding]:
    """Group identical issues into one finding carrying all references.

    qa-run-book.md → Procedure 6. Refs are de-duplicated and kept in first-seen
    order so the report reads in canonical order when the checkers walked the
    corpus in canonical order.
    """
    grouped: dict[tuple[str, ...], Finding] = {}
    for finding in findings:
        key = finding.group_key
        existing = grouped.get(key)
        if existing is None:
            grouped[key] = finding
            continue
        seen = dict(zip(existing.refs, existing.cell_ids or ("",) * len(existing.refs)))
        for ref, cell_id in zip(finding.refs, finding.cell_ids or ("",) * len(finding.refs)):
            seen.setdefault(ref, cell_id)
        grouped[key] = replace(
            existing,
            refs=tuple(seen),
            cell_ids=tuple(seen.values()) if any(seen.values()) else (),
            # The strongest confidence over the group wins: one code-verified
            # instance does not make a model guess code-verified, but the
            # reverse merge must not quietly downgrade a code finding either.
            confidence=_strongest(existing.confidence, finding.confidence),
        )
    return sort(grouped.values())


def _strongest(a: Confidence, b: Confidence) -> Confidence:
    order = {Confidence.HIGH: 0, Confidence.MEDIUM: 1, Confidence.LOW: 2}
    return a if order[a] <= order[b] else b


def sort(findings: Iterable[Finding]) -> list[Finding]:
    """Critical → Query, then by number of verses (qa-run-book.md)."""
    return sorted(
        findings,
        key=lambda f: (SEVERITY_ORDER[f.severity], -len(f.refs), f.skill, f.check),
    )


def tally(findings: Sequence[Finding]) -> dict[Severity, int]:
    counts = {s: 0 for s in Severity}
    for finding in findings:
        counts[finding.severity] += 1
    return counts
