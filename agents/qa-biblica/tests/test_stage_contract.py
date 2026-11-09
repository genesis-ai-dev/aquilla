"""The contract: the harness only ever emits allowed command kinds.

This is the test behind the issue's hardest acceptance criterion — *"No run
stages `cell.validate`, `cell.waive`, `SetTranslation` or `SetSource`, under any
skill, including when a finding has an obvious fix; the harness refuses those
kinds outright."*

It drives `stage.guard` directly rather than through a run, because the point is
that the gate holds for *any* caller, including a future one that builds a
command list by hand.
"""

from __future__ import annotations

import unittest

from qa_biblica import stage
from qa_biblica.api import ScopeDenied
from qa_biblica.findings import Confidence, Finding, Severity, Verifier

from . import fixtures as fx

#: Named in the issue, one by one. Every single one must be refused.
FORBIDDEN_COMMANDS = ("SetTranslation", "SetSource")
FORBIDDEN_EVENTS = ("cell.validate", "cell.waive", "cell.unvalidate", "cell.unwaive")


def finding(**overrides) -> Finding:
    base = dict(
        skill="qa-text-integrity",
        check="Stray markup — HTML/XML tag",
        severity=Severity.CRITICAL,
        confidence=Confidence.HIGH,
        refs=("JHN 3:16",),
        cell_ids=("cell-1",),
        file_id="file-1",
        found="<i> in the target text",
        evidence="1 occurrence",
        proposed_fix="remove the tag",
        verifier=Verifier.POST_EDITOR,
    )
    base.update(overrides)
    return Finding(**base)


class GuardTest(unittest.TestCase):
    def test_allowed_kinds_are_exactly_the_three_the_skills_permit(self):
        self.assertEqual(
            {"EmitEvents", "AddDecision", "AddNote"}, set(stage.ALLOWED_COMMAND_KINDS)
        )

    def test_report_comment_passes_the_guard(self):
        stage.guard([stage.report_comment(file_id="f1", cell_id="c1", body="# QA report")])

    def test_memory_commands_pass_the_guard(self):
        stage.guard([stage.decision("qa-style-characters", "the approved set is …")])
        stage.guard([stage.note(file_id="f1", cell_id="c1", text="checked")])

    def test_forbidden_command_kinds_are_refused(self):
        for kind in FORBIDDEN_COMMANDS:
            with self.subTest(kind=kind):
                with self.assertRaises(stage.ForbiddenCommand) as caught:
                    stage.guard([{"kind": kind, "fileId": "f1", "cellId": "c1", "value": "fixed"}])
                self.assertIn(kind, str(caught.exception))

    def test_forbidden_event_kinds_are_refused(self):
        for kind in FORBIDDEN_EVENTS:
            with self.subTest(kind=kind):
                with self.assertRaises(stage.ForbiddenCommand) as caught:
                    stage.guard(
                        [
                            {
                                "kind": "EmitEvents",
                                "events": [
                                    {"kind": kind, "fileId": "f1", "cellId": "c1", "payload": {}}
                                ],
                            }
                        ]
                    )
                self.assertIn(kind, str(caught.exception))

    def test_term_status_decisions_are_refused(self):
        """"Never change term status yourself" — qa-key-terms-names.md → 8."""
        for kind in ("term.approve", "term.reject", "term.delete"):
            with self.subTest(kind=kind):
                with self.assertRaises(stage.ForbiddenCommand):
                    stage.guard(
                        [{"kind": "EmitEvents", "events": [{"kind": kind, "payload": {}}]}]
                    )

    def test_a_forbidden_kind_hidden_among_allowed_ones_is_still_refused(self):
        with self.assertRaises(stage.ForbiddenCommand):
            stage.guard(
                [
                    {
                        "kind": "EmitEvents",
                        "events": [
                            {"kind": "comment.create", "fileId": "f1", "cellId": "c1", "payload": {"body": "x"}},
                            {"kind": "cell.validate", "fileId": "f1", "cellId": "c1", "payload": {}},
                        ],
                    }
                ]
            )

    def test_an_unknown_kind_is_refused_rather_than_passed_through(self):
        with self.assertRaises(stage.ForbiddenCommand):
            stage.guard([{"kind": "SomeFutureCommand"}])

    def test_comment_create_without_its_file_id_is_refused(self):
        with self.assertRaises(stage.ForbiddenCommand) as caught:
            stage.guard(
                [
                    {
                        "kind": "EmitEvents",
                        "events": [{"kind": "comment.create", "cellId": "c1", "payload": {"body": "x"}}],
                    }
                ]
            )
        self.assertIn("project comment", str(caught.exception))

    def test_a_batch_over_the_api_limit_is_refused(self):
        events = [
            {"kind": "comment.create", "fileId": "f1", "cellId": f"c{i}", "payload": {"body": "x"}}
            for i in range(stage.MAX_EVENTS_PER_CHANGESET + 1)
        ]
        with self.assertRaises(stage.ForbiddenCommand) as caught:
            stage.guard([{"kind": "EmitEvents", "events": events}])
        self.assertIn("200", str(caught.exception))


class FindingCommentsTest(unittest.TestCase):
    def test_findings_batch_at_two_hundred_events(self):
        findings = [
            finding(refs=(f"JHN 3:{n}",), cell_ids=(f"cell-{n}",), found=f"issue {n}")
            for n in range(1, 451)
        ]
        batches = stage.finding_comments(findings)
        self.assertEqual([200, 200, 50], [len(b["events"]) for b in batches])
        for batch in batches:
            stage.guard([batch])

    def test_a_critical_finding_carries_the_critical_marker(self):
        body = stage.render_finding_comment(finding(severity=Severity.CRITICAL))
        self.assertTrue(body.startswith("[CRITICAL] "))

    def test_a_minor_finding_carries_no_marker(self):
        body = stage.render_finding_comment(finding(severity=Severity.MINOR, confidence=Confidence.HIGH))
        self.assertFalse(body.startswith("[CRITICAL]"))

    def test_the_comment_carries_the_fingerprint_for_the_next_run(self):
        one = finding()
        self.assertIn(f"qa-biblica:{one.fingerprint}", stage.render_finding_comment(one))

    def test_a_book_level_finding_gets_no_cell_comment(self):
        self.assertEqual([], stage.finding_comments([finding(refs=(), cell_ids=())]))


class BaselineSlugTest(unittest.TestCase):
    def test_the_skills_paths_map_into_the_flat_memory_namespace(self):
        self.assertEqual("qa-style-characters", stage.baseline_slug("style/characters"))
        self.assertEqual("qa-glossary-wordlist-approved", stage.baseline_slug("glossary/wordlist-approved"))

    def test_every_mapped_slug_is_a_legal_memory_slug(self):
        import re

        from qa_biblica.baseline import ALL_PATHS

        legal = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
        for path in ALL_PATHS:
            with self.subTest(path=path):
                self.assertRegex(stage.baseline_slug(path), legal)


class StagerTest(unittest.TestCase):
    def test_dry_run_never_calls_prepare(self):
        api = fx.FakeApi()
        stager = stage.Stager(api, "proj-1", dry_run=True)
        result = stager.stage([stage.report_comment(file_id="f1", cell_id="c1", body="# QA report")])
        self.assertEqual([], api.prepared)
        self.assertNotIn("POST /changesets", api.calls)
        self.assertEqual(1, len(result.staged))

    def test_ask_mode_stops_at_the_approval_url(self):
        api = fx.FakeApi(autonomy="ask")
        result = stage.Stager(api, "proj-1").stage(
            [stage.report_comment(file_id="f1", cell_id="c1", body="# QA report")]
        )
        self.assertTrue(result.staged[0].awaiting_approval)
        self.assertFalse(result.staged[0].committed)
        self.assertEqual(
            ["https://aquilla.app/approve/cs-1"], result.approval_urls
        )

    def test_a_read_only_token_fails_loudly_at_the_first_write(self):
        api = fx.FakeApi(prepare_error=ScopeDenied("scope_denied", "token is read-only", 403))
        result = stage.Stager(api, "proj-1").stage(
            [stage.report_comment(file_id="f1", cell_id="c1", body="# QA report")]
        )
        self.assertEqual("token is read-only", result.scope_denied)
        self.assertEqual([], result.approval_urls)

    def test_the_guard_runs_before_any_request_is_built(self):
        api = fx.FakeApi()
        with self.assertRaises(stage.ForbiddenCommand):
            stage.Stager(api, "proj-1").stage(
                [
                    stage.report_comment(file_id="f1", cell_id="c1", body="# QA report"),
                    {"kind": "SetTranslation", "fileId": "f1", "cellId": "c1", "value": "fixed"},
                ]
            )
        self.assertEqual([], api.prepared)
        self.assertEqual([], api.calls)


if __name__ == "__main__":
    unittest.main()
