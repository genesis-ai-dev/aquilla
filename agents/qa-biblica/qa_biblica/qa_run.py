"""The orchestrator — `skills/qa-run-book.md` → Order and Procedure.

Passes 1-3 run here, as deterministic code. Passes 4-5 (`qa-meaning-fidelity`,
`qa-notes-headings-names`, `qa-publish-readiness`) and the prose judgments are
the model's half of the run: this module assembles the corpus, the baseline and
the code findings, writes them to disk, and names those passes in "Not checked"
with the reason. That is the honest division the issue's design decision draws,
and it is why the report can claim High confidence for everything it reports.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .api import AgentApi
from .baseline import Baseline, load_baseline
from .checks import (
    capitalization_numbers,
    chapter_verse,
    characters_punctuation,
    key_terms_names,
    spelling_wordlist,
    text_integrity,
)
from .corpus import Corpus
from .findings import Finding, merge
from .reader import read_builtin_checks, read_corpus, resolve_lane, resolve_project
from .report import Report, drop_already_reported, previous_fingerprints
from .scope import Scope, ScopeMode
from .stage import Stager, finding_comments, report_comment

#: Passes this runner does not execute, and why. They go in the report's
#: "Not checked" section verbatim, so a mentor is never left to assume.
NOT_CHECKED: tuple[str, ...] = (
    "Pass 3 qa-parallel-passages: needs parallel-passages.md on disk and is run as a "
    "separate model pass; not part of the code passes.",
    "Pass 4 qa-meaning-fidelity: an AI judgment pass. Run it on a named chapter with the "
    "skill file; it is not run as code and never carries High confidence.",
    "Pass 5 qa-notes-headings-names and qa-publish-readiness: book-level model passes over "
    "the same corpus file this run wrote.",
    "Aquilla's per-cell built-in violations: the Agent API has no per-cell violations read "
    "(quality is file-level), so built-in findings are cited by check name and not merged "
    "verse by verse.",
    *chapter_verse.NOT_CHECKED,
)


@dataclass
class RunArtifacts:
    """Everything the run put on disk, for the operator and for the next run."""

    corpus_path: Path | None = None
    report_path: Path | None = None
    new_words_path: Path | None = None


@dataclass
class RunResult:
    scope: Scope
    corpus: Corpus
    baseline: Baseline
    report: Report
    findings: list[Finding] = field(default_factory=list)
    suppressed: int = 0
    artifacts: RunArtifacts = field(default_factory=RunArtifacts)
    stage_result: object | None = None
    #: Set when the baseline is incomplete and the run stopped before the passes.
    halted: str | None = None

    @property
    def approval_urls(self) -> list[str]:
        urls = getattr(self.stage_result, "approval_urls", None)
        return list(urls) if urls else []


def run_book(
    api: AgentApi,
    project_id: str,
    scope: Scope,
    *,
    out_dir: str | Path,
    lane: str | None = None,
    source_text: str = "",
    dry_run: bool = False,
    stage_finding_comments: bool = False,
    run_date: str | None = None,
) -> RunResult:
    """Run the code passes over `scope` and stage the report.

    `stage_finding_comments` is off by default: the skills' primary artefact is
    *one* report comment on the first cell of the scope. Per-finding cell
    comments are the opt-in, because 200-per-changeset batches of them are a lot
    of noise for a mentor who has not asked for them yet.
    """
    directory = Path(out_dir)
    directory.mkdir(parents=True, exist_ok=True)

    resolve_project(api, project_id)
    files = api.files(project_id)
    lane_id = resolve_lane(api, project_id, files, lane)

    corpus, read_log = read_corpus(api, project_id, scope, lane=lane_id, files=files)
    artifacts = RunArtifacts()
    artifacts.corpus_path = directory / "corpus.jsonl"
    corpus.write_jsonl(str(artifacts.corpus_path))

    terms = api.terms(project_id)
    baseline = load_baseline(api.memory(project_id, status="approved"), terms=terms)

    report = Report(
        scope=scope.label,
        source_text=source_text,
        run_date=run_date or date.today().isoformat(),
        snapshot_at=corpus.snapshot_at,
        baseline_verified=baseline.verified_on,
        code_log=list(read_log),
    )

    if not baseline.complete:
        # qa-run-book.md → Before you start: stop and suggest the bootstrap.
        report.not_checked = [baseline.missing_message, *NOT_CHECKED]
        artifacts.report_path = _write_report(directory, report)
        return RunResult(
            scope=scope,
            corpus=corpus,
            baseline=baseline,
            report=report,
            artifacts=artifacts,
            halted=baseline.missing_message,
        )

    builtin = read_builtin_checks(api, project_id)
    collected: list[Finding] = []
    not_checked: list[str] = []

    for finding_set in _pass_one(corpus, baseline, scope):
        collected.extend(finding_set.findings)
        report.code_log.extend(finding_set.code_log)
        not_checked.extend(finding_set.not_checked)

    if 2 in scope.passes:
        spelling = spelling_wordlist.run(corpus, baseline)
        collected.extend(spelling.findings.findings)
        report.code_log.extend(spelling.findings.code_log)
        not_checked.extend(spelling.findings.not_checked)
        if spelling.new_words:
            artifacts.new_words_path = _write_new_words(directory, spelling.new_words)

    if 3 in scope.passes:
        consistency = api.term_consistency(project_id, lane=lane_id)
        terms_set = key_terms_names.run(
            corpus, terms=terms, consistency=consistency, violations=builtin
        )
        collected.extend(terms_set.findings)
        report.code_log.extend(terms_set.code_log)
        not_checked.extend(terms_set.not_checked)

    merged = merge(collected)

    # Idempotency: a previous run's report (and its per-finding comments) carry
    # their fingerprints, so re-running an unchanged scope reports nothing new.
    anchor = corpus.first_verse()
    previous: frozenset[str] = frozenset()
    if anchor is not None:
        previous = previous_fingerprints(
            api.comments(project_id, file_id=anchor.file_id, cell_id=anchor.cell_id)
        )
    kept, suppressed = drop_already_reported(merged, previous)
    if suppressed:
        report.code_log.append(
            f"idempotency: {len(merged)} finding(s) after grouping, {suppressed} already "
            f"reported on {anchor.ref_label if anchor else 'the anchor cell'}, {len(kept)} new"
        )

    report.findings = kept
    report.previously_reported = previous
    report.not_checked = [*not_checked, *NOT_CHECKED]
    artifacts.report_path = _write_report(directory, report)

    stager = Stager(api, project_id, dry_run=dry_run)
    commands: list[dict] = []
    if anchor is not None and kept:
        commands.append(
            report_comment(file_id=anchor.file_id, cell_id=anchor.cell_id, body=report.render())
        )
        if stage_finding_comments:
            commands.extend(finding_comments(kept))
    stage_result = stager.stage(commands) if commands else None

    return RunResult(
        scope=scope,
        corpus=corpus,
        baseline=baseline,
        report=report,
        findings=kept,
        suppressed=suppressed,
        artifacts=artifacts,
        stage_result=stage_result,
    )


def _pass_one(corpus: Corpus, baseline: Baseline, scope: Scope):
    """Pass 1 in the order qa-run-book.md → Order 1 gives."""
    if 1 not in scope.passes:
        return []
    return [
        chapter_verse.run(corpus),
        text_integrity.run(corpus, approved_characters=baseline.characters),
        characters_punctuation.run(corpus, baseline),
        capitalization_numbers.run(corpus, baseline),
    ]


def _write_report(directory: Path, report: Report) -> Path:
    """The report as a file — qa-run-book.md → 7 offers it as one."""
    path = directory / "qa-report.md"
    path.write_text(report.render(), encoding="utf-8")
    return path


def _write_new_words(directory: Path, new_words) -> Path:
    """`qa-spelling-wordlist.md` → Output: the new-word list, offered as a CSV."""
    import csv

    path = directory / "new-words.csv"
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["word", "count", "references", "nearest approved word", "Decision"])
        for entry in new_words:
            writer.writerow(
                [entry.word, entry.count, "; ".join(entry.refs), entry.nearest_approved, ""]
            )
    return path


def run_bootstrap(
    api: AgentApi,
    project_id: str,
    *,
    approved_books: tuple[str, ...],
    out_dir: str | Path,
    lane: str | None = None,
    key_terms_path: str | None = None,
) -> tuple[list[Path], list[str]]:
    """Pass 0 — build the six verification CSVs from the approved books."""
    from . import bootstrap as bootstrap_module
    from .scope import Scope as ScopeType

    directory = Path(out_dir)
    directory.mkdir(parents=True, exist_ok=True)

    resolve_project(api, project_id)
    files = api.files(project_id)
    lane_id = resolve_lane(api, project_id, files, lane)
    scope = ScopeType(mode=ScopeMode.BOOK, books=approved_books)
    corpus, read_log = read_corpus(api, project_id, scope, lane=lane_id, files=files)
    corpus.write_jsonl(str(directory / "corpus.jsonl"))

    key_terms = bootstrap_module.read_key_terms(key_terms_path) if key_terms_path else {}
    result = bootstrap_module.build(corpus, approved_books=approved_books, key_terms=key_terms)
    paths = result.write_all(directory)
    return paths, [*read_log, *result.code_log, *result.summaries()]
