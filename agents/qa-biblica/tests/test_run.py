"""End-to-end runs against the fake API, one test per acceptance criterion."""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

from qa_biblica.api import ScopeDenied
from qa_biblica.findings import Confidence, Finding, FindingRuleError, Severity, Verifier, merge
from qa_biblica.qa_run import run_bootstrap, run_book
from qa_biblica.reader import ProjectUnreachable
from qa_biblica.report import Report, previous_fingerprints
from qa_biblica.scope import ScopeError, ScopeMode, parse_scope

from . import fixtures as fx


def drafts():
    """A remaining book with the faults the issue's test checklist plants."""
    return [
        fx.verse("MRK 1:1", "The beginning of the gospel of Jesus Christ.", "The beginning of the gospel of Jesus Christ.", last_edit_at=1000),
        fx.verse("MRK 1:2", "As it is written in Isaiah the prophet.", "As it is written in <i>Isaiah</i> the prophet.", last_edit_at=2000),
        fx.verse("MRK 1:3", "A voice crying in the wilderness.", "A voice crying in the wilderness.", last_edit_at=1000),
        fx.verse("MRK 1:4", "John appeared, baptizing, and there were 40 people.", "John appeared, baptizing, and there were 30 people.", last_edit_at=2000),
    ]


class RunBookTest(unittest.TestCase):
    def setUp(self):
        self.verses = drafts()
        self.api = fx.FakeApi(
            cells={"file-1": fx.cell_rows(*self.verses, changed={"cell-MRK-1-2", "cell-MRK-1-4"})},
            memory=fx.memory_with_baseline(),
        )
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_scope(self, phrase="MRK", **kwargs):
        scope = parse_scope(phrase) if isinstance(phrase, str) else phrase
        return run_book(
            self.api, "proj-1", scope, out_dir=self.tmp.name, source_text="NIV", **kwargs
        )

    def test_projects_is_the_first_authenticated_call(self):
        self.run_scope(dry_run=True)
        self.assertEqual("GET /projects", self.api.calls[0])

    def test_a_project_the_token_cannot_read_stops_at_projects(self):
        api = fx.FakeApi(projects=[{"id": "other-project", "name": "Someone else's"}])
        with self.assertRaises(ProjectUnreachable) as caught:
            run_book(api, "proj-1", parse_scope("MRK"), out_dir=self.tmp.name)
        message = str(caught.exception)
        self.assertIn("cannot read project proj-1", message)
        self.assertIn("other-project", message)
        self.assertEqual(["GET /projects"], api.calls)

    def test_the_report_is_staged_as_a_comment_on_the_first_cell_of_the_scope(self):
        result = self.run_scope()
        self.assertEqual(1, len(self.api.prepared))
        command = self.api.prepared[0][0]
        self.assertEqual("EmitEvents", command["kind"])
        event = command["events"][0]
        self.assertEqual("comment.create", event["kind"])
        self.assertEqual("cell-MRK-1-1", event["cellId"])
        self.assertEqual("file-1", event["fileId"])
        self.assertIn("# QA report — MRK", event["payload"]["body"])

    def test_nothing_is_written_until_a_person_approves(self):
        result = self.run_scope()
        self.assertEqual(["https://aquilla.app/approve/cs-1"], result.approval_urls)
        self.assertTrue(result.stage_result.staged[0].awaiting_approval)
        self.assertFalse(result.stage_result.staged[0].committed)

    def test_the_report_is_also_offered_as_a_file(self):
        result = self.run_scope()
        path = result.artifacts.report_path
        self.assertTrue(path and path.exists())
        self.assertIn("## Summary", path.read_text(encoding="utf-8"))

    def test_the_corpus_is_written_to_jsonl(self):
        result = self.run_scope(dry_run=True)
        path = result.artifacts.corpus_path
        self.assertTrue(path and path.exists())
        lines = path.read_text(encoding="utf-8").strip().split("\n")
        self.assertIn("_meta", lines[0])
        self.assertEqual(len(self.verses) + 1, len(lines))

    def test_the_planted_faults_are_found_with_high_confidence(self):
        result = self.run_scope(dry_run=True)
        checks = {f.check: f for f in result.findings}
        self.assertIn("Stray markup — HTML/XML tag", checks)
        self.assertIn("Number mismatch", checks)
        self.assertEqual(Severity.CRITICAL, checks["Stray markup — HTML/XML tag"].severity)
        self.assertEqual(Confidence.HIGH, checks["Stray markup — HTML/XML tag"].confidence)
        self.assertEqual(Severity.MAJOR, checks["Number mismatch"].severity)

    def test_dry_run_renders_the_report_without_calling_prepare(self):
        result = self.run_scope(dry_run=True)
        self.assertEqual([], self.api.prepared)
        self.assertNotIn("POST /changesets", self.api.calls)
        self.assertTrue(result.artifacts.report_path.exists())
        self.assertTrue(result.findings)

    def test_an_incomplete_baseline_halts_the_run_and_suggests_the_bootstrap(self):
        api = fx.FakeApi(
            cells={"file-1": fx.cell_rows(*self.verses)},
            memory={"brief": {"content": ""}, "data": []},
        )
        result = run_book(api, "proj-1", parse_scope("MRK"), out_dir=self.tmp.name)
        self.assertIsNotNone(result.halted)
        self.assertIn("qa-bootstrap-inventories", result.halted)
        self.assertEqual([], api.prepared)

    def test_re_running_an_unchanged_scope_reports_nothing_new(self):
        """Idempotent against its own previous report."""
        first = self.run_scope(dry_run=True)
        self.assertTrue(first.findings)
        prior_report = first.report.render()

        api = fx.FakeApi(
            cells={"file-1": fx.cell_rows(*self.verses)},
            memory=fx.memory_with_baseline(),
            comments=[{"commentId": "cm1", "cellId": "cell-MRK-1-1", "body": prior_report}],
        )
        second = run_book(api, "proj-1", parse_scope("MRK"), out_dir=self.tmp.name)
        self.assertEqual([], second.findings)
        self.assertEqual(len(first.findings), second.suppressed)
        self.assertEqual([], api.prepared, msg="nothing new to report means nothing staged")

    def test_a_read_only_token_completes_every_read_then_fails_at_the_write(self):
        api = fx.FakeApi(
            cells={"file-1": fx.cell_rows(*self.verses)},
            memory=fx.memory_with_baseline(),
            prepare_error=ScopeDenied("scope_denied", "this credential is read-only", 403),
        )
        result = run_book(api, "proj-1", parse_scope("MRK"), out_dir=self.tmp.name)
        self.assertEqual("this credential is read-only", result.stage_result.scope_denied)
        # Every read happened, and the files survive the refusal.
        self.assertIn("GET /terms/consistency", api.calls)
        self.assertTrue(result.artifacts.report_path.exists())
        self.assertTrue(result.artifacts.corpus_path.exists())

    def test_a_chapter_scope_runs_passes_one_to_four_only(self):
        scope = parse_scope("MRK 1")
        self.assertEqual((1, 2, 3, 4), scope.passes)
        result = self.run_scope(scope, dry_run=True)
        self.assertIn("MRK 1", result.report.render())


class EditedCellsTest(unittest.TestCase):
    def setUp(self):
        self.verses = drafts()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def scope(self, **kwargs):
        return parse_scope(
            "approved books, edited cells only",
            approved_books=("MRK",),
            edited_since="2026-10-01",
            **kwargs,
        )

    def test_cells_not_edited_since_the_date_produce_no_findings(self):
        api = fx.FakeApi(
            cells={"file-1": fx.cell_rows(*self.verses)},
            memory=fx.memory_with_baseline(),
        )
        scope = self.scope()
        # The approval date is well past both lastEditAt values in the fixture,
        # so nothing is in scope and nothing can be reported.
        result = run_book(api, "proj-1", scope, out_dir=self.tmp.name, dry_run=True)
        self.assertEqual(0, len(result.corpus))
        self.assertEqual([], result.findings)

    def test_the_since_cursor_decides_what_changed(self):
        api = fx.FakeApi(
            cells={"file-1": fx.cell_rows(*self.verses, changed={"cell-MRK-1-2"})},
            memory=fx.memory_with_baseline(),
        )
        result = run_book(
            api, "proj-1", self.scope(since_seq=42), out_dir=self.tmp.name, dry_run=True
        )
        self.assertEqual(["cell-MRK-1-2"], [v.cell_id for v in result.corpus])
        self.assertTrue(any("since=42" in call for call in api.calls))
        self.assertTrue(result.findings, "the one edited cell has the planted <i> tag")

    def test_only_edited_cells_are_checked_when_two_were_edited(self):
        verses = drafts()
        for item in verses:
            item.last_edit_at = 0
        verses[1].last_edit_at = fx_ms("2026-10-15")
        verses[3].last_edit_at = fx_ms("2026-10-16")
        api = fx.FakeApi(
            cells={"file-1": fx.cell_rows(*verses)}, memory=fx.memory_with_baseline()
        )
        result = run_book(api, "proj-1", self.scope(), out_dir=self.tmp.name, dry_run=True)
        self.assertEqual(
            ["cell-MRK-1-2", "cell-MRK-1-4"], sorted(v.cell_id for v in result.corpus)
        )

    def test_the_mode_runs_passes_one_to_three(self):
        self.assertEqual((1, 2, 3), self.scope().passes)

    def test_the_mode_refuses_to_guess_the_approved_books(self):
        with self.assertRaises(ScopeError) as caught:
            parse_scope("approved books, edited cells only")
        self.assertIn("--approved-books", str(caught.exception))

    def test_the_mode_refuses_to_guess_the_approval_date(self):
        with self.assertRaises(ScopeError) as caught:
            parse_scope("approved books, edited cells only", approved_books=("MRK",))
        self.assertIn("--edited-since", str(caught.exception))


def fx_ms(date_text: str) -> int:
    from qa_biblica.scope import parse_date_ms

    return parse_date_ms(date_text)


class ScopeTest(unittest.TestCase):
    def test_a_book(self):
        scope = parse_scope("MRK")
        self.assertEqual(ScopeMode.BOOK, scope.mode)
        self.assertEqual(("MRK",), scope.books)
        self.assertEqual((1, 2, 3, 4, 5), scope.passes)

    def test_a_bracketed_book_as_the_composer_writes_it(self):
        self.assertEqual(("MRK",), parse_scope("[MRK]").books)

    def test_a_chapter(self):
        scope = parse_scope("ROM 3")
        self.assertEqual(ScopeMode.CHAPTER, scope.mode)
        self.assertEqual(3, scope.chapter)
        self.assertEqual("ROM 3", scope.label)

    def test_a_numbered_book(self):
        self.assertEqual(("1CO",), parse_scope("1CO").books)

    def test_an_unknown_phrase_is_refused_with_the_three_modes_named(self):
        with self.assertRaises(ScopeError) as caught:
            parse_scope("the whole bible please")
        self.assertIn("approved books, edited cells only", str(caught.exception))

    def test_chapter_scope_excludes_other_chapters(self):
        scope = parse_scope("MRK 2")
        self.assertTrue(scope.includes("MRK", 2))
        self.assertFalse(scope.includes("MRK", 1))
        self.assertFalse(scope.includes("LUK", 2))


class FindingRulesTest(unittest.TestCase):
    def test_low_confidence_is_always_a_query(self):
        with self.assertRaises(FindingRuleError) as caught:
            Finding(
                skill="qa-meaning-fidelity",
                check="Meaning shift",
                severity=Severity.MAJOR,
                confidence=Confidence.LOW,
            )
        self.assertIn("Low confidence is always a Query", str(caught.exception))

    def test_a_model_produced_finding_cannot_claim_high_confidence(self):
        from qa_biblica.findings import ProducedBy

        with self.assertRaises(FindingRuleError):
            Finding(
                skill="qa-meaning-fidelity",
                check="Omission",
                severity=Severity.MAJOR,
                confidence=Confidence.HIGH,
                produced_by=ProducedBy.MODEL,
            )

    def test_identical_issues_merge_into_one_finding_with_every_reference(self):
        shared = dict(
            skill="qa-text-integrity",
            check="Stray markup — HTML/XML tag",
            severity=Severity.CRITICAL,
            confidence=Confidence.HIGH,
            found="<i> in the target text",
            evidence="1 occurrence",
            proposed_fix="remove the tag",
            verifier=Verifier.POST_EDITOR,
            file_id="file-1",
        )
        merged = merge(
            [
                Finding(refs=("MRK 1:2",), cell_ids=("c2",), **shared),
                Finding(refs=("MRK 1:5",), cell_ids=("c5",), **shared),
            ]
        )
        self.assertEqual(1, len(merged))
        self.assertEqual(("MRK 1:2", "MRK 1:5"), merged[0].refs)

    def test_findings_sort_critical_first_then_by_verse_count(self):
        def one(severity, refs):
            return Finding(
                skill="s", check=f"c{len(refs)}{severity.value}", severity=severity,
                confidence=Confidence.HIGH, refs=refs,
            )

        order = merge(
            [
                one(Severity.MINOR, ("A 1:1",)),
                one(Severity.CRITICAL, ("B 1:1",)),
                one(Severity.MAJOR, ("C 1:1", "C 1:2")),
                one(Severity.MAJOR, ("D 1:1",)),
            ]
        )
        self.assertEqual(
            [Severity.CRITICAL, Severity.MAJOR, Severity.MAJOR, Severity.MINOR],
            [f.severity for f in order],
        )
        self.assertEqual(2, len(order[1].refs))


class ReportTest(unittest.TestCase):
    def report(self, findings=()) -> Report:
        return Report(
            scope="MRK",
            source_text="NIV",
            run_date="2026-11-03",
            snapshot_at="2026-11-03T00:00:00+00:00",
            baseline_verified="2026-10-01",
            findings=list(findings),
        )

    def test_the_header_states_the_snapshot_and_the_baseline_date(self):
        body = self.report().render()
        self.assertIn("# QA report — MRK — 2026-11-03", body)
        self.assertIn("Source text: NIV", body)
        self.assertIn("Baseline: verified 2026-10-01", body)
        self.assertIn("API snapshot: 2026-11-03T00:00:00+00:00", body)

    def test_the_sections_follow_the_skill_files_format(self):
        body = self.report().render()
        for heading in ("## Summary", "## Findings (grouped", "## Not checked"):
            self.assertIn(heading, body)
        self.assertIn("| Pass | Critical | Major | Minor | Query |", body)
        self.assertIn(
            "| # | Refs | Skill | Severity | Confidence | Found | Baseline / evidence | Proposed fix | Verifier |",
            body,
        )

    def test_a_clean_scope_reads_ready(self):
        self.assertIn("Gate status: READY (0 Critical open, 0 Major open)", self.report().render())

    def test_a_critical_finding_reads_not_ready(self):
        finding = Finding(
            skill="qa-chapter-verse", check="Missing verse", severity=Severity.CRITICAL,
            confidence=Confidence.HIGH, refs=("MRK 1:2",),
        )
        body = self.report([finding]).render()
        self.assertIn("Gate status: NOT READY (1 Critical open, 0 Major open)", body)
        self.assertIn("| 1 Mechanical | 1 | 0 | 0 | 0 |", body)

    def test_a_pipe_in_a_finding_cannot_break_the_table(self):
        finding = Finding(
            skill="qa-text-integrity", check="Stray markup — unapproved symbol",
            severity=Severity.CRITICAL, confidence=Confidence.HIGH, refs=("MRK 1:1",),
            found="'|' appears in the target text",
        )
        body = self.report([finding]).render()
        row = [line for line in body.split("\n") if line.startswith("| 1 |")][0]
        self.assertIn("\\|", row, msg="the literal pipe must be escaped")
        cells = re.split(r"(?<!\\)\|", row.strip("|"))
        self.assertEqual(9, len(cells), msg=row)

    def test_fingerprints_round_trip_through_a_comment(self):
        finding = Finding(
            skill="qa-chapter-verse", check="Missing verse", severity=Severity.CRITICAL,
            confidence=Confidence.HIGH, refs=("MRK 1:2",),
        )
        body = self.report([finding]).render()
        self.assertEqual(
            frozenset({finding.fingerprint}), previous_fingerprints([{"body": body}])
        )

    def test_a_comment_that_is_not_ours_contributes_no_fingerprints(self):
        self.assertEqual(
            frozenset(), previous_fingerprints([{"body": "Looks good to me, thanks!"}])
        )


class BootstrapRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_the_six_csvs_are_produced_from_api_read_cells(self):
        api = fx.FakeApi(cells={"file-1": fx.cell_rows(*fx.latin_clean().verses)})
        paths, log = run_bootstrap(
            api, "proj-1", approved_books=("JHN",), out_dir=self.tmp.name
        )
        self.assertEqual(
            [
                "characters.csv",
                "punctuation.csv",
                "conventions.csv",
                "wordlist.csv",
                "keyterms.csv",
                "names.csv",
            ],
            [Path(p).name for p in paths],
        )
        for path in paths:
            self.assertTrue(Path(path).exists())
        self.assertTrue(any("cells with target text" in line for line in log))

    def test_the_run_log_carries_the_code_output_summary(self):
        api = fx.FakeApi(cells={"file-1": fx.cell_rows(*fx.latin_clean().verses)})
        _, log = run_bootstrap(api, "proj-1", approved_books=("JHN",), out_dir=self.tmp.name)
        joined = "\n".join(log)
        for expected in ("characters.csv:", "wordlist.csv:", "names.csv:"):
            self.assertIn(expected, joined)

    def test_the_bootstrap_refuses_a_book_that_is_not_approved(self):
        from qa_biblica import bootstrap

        with self.assertRaises(ValueError) as caught:
            bootstrap.build(fx.latin_clean(), approved_books=("MRK",))
        self.assertIn("only read approved books", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
