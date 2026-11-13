"""Changeset staging, and the allowlist that makes the skills' promises real.

`skills/qa-run-book.md` → Do not: *"Apply fixes, approve terms, or approve
words."* Several other skill files repeat it per pass ("Never auto-fix spelling
variants, key terms, names or meaning. Propose; a person decides"). The runner
keeps that promise in one place, structurally:

* `build_*` turns findings into commands. Every command it can produce is in
  `ALLOWED_COMMAND_KINDS`.
* `guard` re-checks the finished command list against the allowlist **before a
  request is built**, so a forbidden kind can never reach the wire — not through
  a new call site, not through a caller passing hand-rolled commands, and not
  because a finding "had an obvious fix".

That second step is the one worth having. The first is a convention; this is a
gate, and the contract test drives it directly.

The forbidden set is named explicitly rather than inferred as "anything not
allowed", so the four kinds the issue calls out by name produce a message that
says *why* they are refused rather than a generic "unknown kind".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from .api import AgentApi, ApiError, ConfirmationRequired, ScopeDenied
from .findings import Finding, Severity

#: Changeset command kinds the QA runner may stage. Everything the skills permit
#: is here, and nothing else: reports and findings are comments, verified lists
#: are memory entries.
ALLOWED_COMMAND_KINDS: frozenset[str] = frozenset({"EmitEvents", "AddDecision", "AddNote"})

#: Event kinds allowed inside an `EmitEvents` command.
#: `term.create`/`term.update` ride the bootstrap's after-verification step only
#: (`qa-key-terms-names.md` → Termbase set-up 3), and even there they are a
#: proposal a human approves.
ALLOWED_EVENT_KINDS: frozenset[str] = frozenset({"comment.create", "term.create", "term.update"})

#: Refused outright, with the reason the refusal exists.
FORBIDDEN_KINDS: dict[str, str] = {
    "SetTranslation": "the runner never edits a cell — findings are proposals (qa-run-book.md → Do not)",
    "SetSource": "the source text is a meaning reference, never a thing QA rewrites",
    "cell.validate": "validation is the mentor's publish decision, not a QA result",
    "cell.unvalidate": "un-validating someone's approved work is never a QA finding",
    "cell.waive": "waiving a rule hides a finding instead of reporting it",
    "cell.unwaive": "un-waiving reverses a person's decision",
    "term.approve": "approving a rendering is the mentor's call (qa-key-terms-names.md → 8)",
    "term.reject": "rejecting a rendering is the mentor's call (qa-key-terms-names.md → 8)",
    "term.delete": "deleting a concept is destructive and never a QA result",
}

#: `EMIT_EVENTS_MAX_EVENTS` in sync-worker/src/external/commands-emit-events.ts.
MAX_EVENTS_PER_CHANGESET = 200


class ForbiddenCommand(RuntimeError):
    """A command the runner refuses to stage. Raised before prepare."""


def guard(commands: Sequence[dict]) -> None:
    """Refuse anything outside the allowlist. Call before every prepare."""
    for index, command in enumerate(commands):
        kind = command.get("kind")
        where = f"commands[{index}]"
        if not isinstance(kind, str) or not kind:
            raise ForbiddenCommand(f"{where}: every command needs a kind")
        if kind in FORBIDDEN_KINDS:
            raise ForbiddenCommand(f"{where}: {kind} is refused — {FORBIDDEN_KINDS[kind]}")
        if kind not in ALLOWED_COMMAND_KINDS:
            raise ForbiddenCommand(
                f"{where}: {kind} is not a kind the QA runner stages "
                f"(allowed: {', '.join(sorted(ALLOWED_COMMAND_KINDS))})"
            )
        if kind != "EmitEvents":
            continue
        events = command.get("events")
        if not isinstance(events, list) or not events:
            raise ForbiddenCommand(f"{where}: EmitEvents needs a non-empty events list")
        if len(events) > MAX_EVENTS_PER_CHANGESET:
            raise ForbiddenCommand(
                f"{where}: {len(events)} events exceeds the API's "
                f"{MAX_EVENTS_PER_CHANGESET}-per-changeset limit"
            )
        for event_index, event in enumerate(events):
            event_kind = event.get("kind") if isinstance(event, dict) else None
            event_where = f"{where}.events[{event_index}]"
            if event_kind in FORBIDDEN_KINDS:
                raise ForbiddenCommand(
                    f"{event_where}: {event_kind} is refused — {FORBIDDEN_KINDS[event_kind]}"
                )
            if event_kind not in ALLOWED_EVENT_KINDS:
                raise ForbiddenCommand(
                    f"{event_where}: {event_kind} is not an event kind the QA runner emits "
                    f"(allowed: {', '.join(sorted(ALLOWED_EVENT_KINDS))})"
                )
            if event_kind == "comment.create" and not (event.get("fileId") and event.get("cellId")):
                raise ForbiddenCommand(
                    f"{event_where}: comment.create with a cellId requires its fileId, "
                    "or it silently demotes to a project comment"
                )


# ---------------------------------------------------------------------------
# Command builders
# ---------------------------------------------------------------------------


def report_comment(*, file_id: str, cell_id: str, body: str) -> dict:
    """The run's one report comment, on the first cell of the scope."""
    return {
        "kind": "EmitEvents",
        "events": [
            {
                "kind": "comment.create",
                "fileId": file_id,
                "cellId": cell_id,
                "payload": {"body": body},
            }
        ],
    }


def finding_comments(findings: Iterable[Finding], *, max_per_changeset: int = MAX_EVENTS_PER_CHANGESET) -> list[dict]:
    """Per-finding cell comments, batched into changesets of ≤200 events.

    One comment per finding on its first ref's cell — the findings are already
    grouped across verses, so this is "one change per finding" as the operating
    rules require, not one per verse. A finding with no cell (a book-level one)
    carries no per-cell comment; it lives in the report.
    """
    events: list[dict] = []
    for finding in findings:
        if not finding.cell_ids:
            continue
        cell_id = finding.cell_ids[0]
        if not cell_id or not finding.file_id:
            continue
        events.append(
            {
                "kind": "comment.create",
                "fileId": finding.file_id,
                "cellId": cell_id,
                "payload": {"body": render_finding_comment(finding)},
            }
        )
    return _batch(events, max_per_changeset)


def render_finding_comment(finding: Finding) -> str:
    """One finding as a cell comment.

    `[CRITICAL]` is in the body for a Critical finding because that is what
    qa-run-book.md → Severity says Aquilla shows for one.
    """
    prefix = "[CRITICAL] " if finding.severity is Severity.CRITICAL else ""
    lines = [
        f"{prefix}**{finding.check}** ({finding.skill}) — {finding.severity.value}, "
        f"confidence {finding.confidence.value}",
        "",
        f"- **Refs:** {finding.ref_summary}",
        f"- **Found:** {finding.found}" if finding.found else "",
        f"- **Baseline / evidence:** {finding.evidence}" if finding.evidence else "",
        f"- **Proposed fix:** {finding.proposed_fix}" if finding.proposed_fix else "",
        f"- **Verifier:** {finding.verifier.value}",
        "",
        f"<!-- qa-biblica:{finding.fingerprint} -->",
    ]
    return "\n".join(line for line in lines if line != "")


def decision(slug: str, text: str, *, rationale: str | None = None) -> dict:
    """An `AddDecision` for a verified baseline list.

    The skills name the baseline paths `style/characters`, `glossary/wordlist-approved`
    and so on. The API's memory paths are a flat namespace per kind —
    `decisions/<slug>.md`, slug matching `^[a-z0-9]+(-[a-z0-9]+)*$`
    (`sync-worker/src/external/commands-memory.ts`) — so a slash cannot be
    expressed. `baseline_slug` does the mapping, and the README records it.
    """
    command: dict[str, Any] = {"kind": "AddDecision", "slug": slug, "decision": text}
    if rationale:
        command["rationale"] = rationale
    return command


def note(*, file_id: str, cell_id: str, text: str, rationale: str | None = None) -> dict:
    command: dict[str, Any] = {"kind": "AddNote", "fileId": file_id, "cellId": cell_id, "note": text}
    if rationale:
        command["rationale"] = rationale
    return command


def baseline_slug(path: str) -> str:
    """`style/characters` → `qa-style-characters`.

    The API's flat `decisions/<slug>.md` namespace cannot hold the skills' own
    `style/*` and `glossary/*` prefixes, so the prefix is folded into the slug
    with a `qa-` marker. The skills are not edited to match (the issue's
    design decision); the mapping is documented in the runner's README.
    """
    cleaned = path.strip().strip("/").replace("/", "-").replace("_", "-").lower()
    return f"qa-{cleaned}" if not cleaned.startswith("qa-") else cleaned


def _batch(events: list[dict], size: int) -> list[dict]:
    return [
        {"kind": "EmitEvents", "events": events[i : i + size]}
        for i in range(0, len(events), size)
    ]


# ---------------------------------------------------------------------------
# Staging
# ---------------------------------------------------------------------------


@dataclass
class StagedChangeset:
    changeset_id: str
    approval_url: str | None
    summary: dict
    digest: str | None = None
    committed: bool = False
    #: Set when ask mode handed the run back to a person.
    awaiting_approval: bool = False


@dataclass
class StageResult:
    staged: list[StagedChangeset] = field(default_factory=list)
    #: Populated when a read-only token refused the write. The run keeps every
    #: file it produced and reports this rather than exiting silently.
    scope_denied: str | None = None

    @property
    def approval_urls(self) -> list[str]:
        return [c.approval_url for c in self.staged if c.approval_url]


class Stager:
    """Prepares (and in act mode commits) the runner's changesets.

    `dry_run` renders and guards everything without calling prepare — the CI
    mode the issue asks for.
    """

    def __init__(self, api: AgentApi, project_id: str, *, dry_run: bool = False) -> None:
        self._api = api
        self._project_id = project_id
        self.dry_run = dry_run
        self.planned: list[dict] = []

    def stage(self, commands: Sequence[dict], *, commit: bool = True) -> StageResult:
        guard(commands)
        result = StageResult()
        for command in commands:
            self.planned.append(command)
            if self.dry_run:
                result.staged.append(
                    StagedChangeset(
                        changeset_id="(dry-run)",
                        approval_url=None,
                        summary={"kind": command["kind"], "dryRun": True},
                    )
                )
                continue
            try:
                prepared = self._api.prepare(self._project_id, [command])
            except ScopeDenied as exc:
                # A read-only token. Not retryable, and the files already on
                # disk are still the run's output — report and stop writing.
                result.scope_denied = exc.message
                return result
            changeset = prepared.get("changeset") or {}
            staged = StagedChangeset(
                changeset_id=str(changeset.get("id", "")),
                approval_url=prepared.get("approvalUrl"),
                summary=prepared.get("summary") or {},
                digest=prepared.get("digest"),
            )
            result.staged.append(staged)
            if not commit:
                continue
            try:
                self._api.commit(
                    self._project_id, staged.changeset_id, approval_url=staged.approval_url
                )
                staged.committed = True
            except ConfirmationRequired:
                # Ask mode: the human opens approvalUrl. Never polled, never
                # retried in a loop (docs/api/QUICKSTART.md §4).
                staged.awaiting_approval = True
            except ScopeDenied as exc:
                result.scope_denied = exc.message
                return result
            except ApiError:
                raise
        return result
