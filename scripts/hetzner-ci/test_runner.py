import io
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import runner
import webhook


class RunnerTests(unittest.TestCase):
    def test_container_memory_comes_from_the_host_config_within_sane_bounds(self):
        # The default is the 3.8 GB host's budget; a resized host raises it in
        # runner.json without a controller change. Swap stays a fraction of RAM.
        self.assertEqual(runner.memory({}), ["--memory=2200m", "--memory-swap=2600m"])
        self.assertEqual(runner.memory({"container_memory_mb": 4000, "container_swap_mb": 500}),
                         ["--memory=4000m", "--memory-swap=4500m"])
        for bad in ({"container_memory_mb": 100}, {"container_memory_mb": 2200, "container_swap_mb": 3000},
                    {"container_memory_mb": "lots"}):
            with self.assertRaises(ValueError):
                runner.memory(bad)

    def test_app_and_test_containers_bake_the_same_browser_urls(self):
        # The app builds against these before its workers start; a test image
        # pointed elsewhere would drive a different stack than the one built.
        self.assertEqual(runner.BROWSER_ENV["VITE_AUTH_BASE"], "http://127.0.0.1:9787")
        self.assertEqual(runner.BROWSER_ENV["VITE_SYNC_WORKER_HOST"], "127.0.0.1:9788")

    def test_untrusted_logs_have_a_hard_cap(self):
        log = io.BytesIO()
        result = runner.command([sys.executable, "-c",
            "import sys; sys.stdout.buffer.write(b'x' * (9 * 1024 * 1024))"], log, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(log.getvalue()), 8 * 1024 * 1024)

    def test_commands_cannot_run_forever(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            runner.command([sys.executable, "-c", "import time; time.sleep(10)"], io.BytesIO(), timeout=0.1)

    def test_persisted_jobs_are_validated_before_use(self):
        ref = "release/2026/10/07-01"
        with patch.object(runner, "current") as current:
            with self.assertRaises(ValueError):
                runner.execute({}, (1, 0, "main;whoami", ref))
            self.assertEqual(runner.execute({}, (1, 716, "a" * 40, "")), "superseded")
            current.assert_not_called()

    def test_stale_jobs_do_not_download_or_start_containers(self):
        with patch.object(runner, "current", return_value=False), patch.object(runner, "command") as command:
            self.assertEqual(
                runner.execute({}, (1, 0, "a" * 40, "release/2026/10/07-01")), "superseded")
            command.assert_not_called()

    def test_github_revalidation_rejects_moved_heads(self):
        ref = "release/2026/10/07-01"
        with patch.object(runner, "github", return_value={"sha": "a" * 40}):
            self.assertTrue(runner.current({}, ref, "a" * 40))
            self.assertFalse(runner.current({}, ref, "b" * 40))
            self.assertFalse(runner.current({}, "dev", "a" * 40))

    def test_provider_settings_never_fall_back_to_another_endpoint(self):
        settings = {"TYPESAFE_API_KEY": "test-decision", "TEXT_MODEL_API_KEY": "test-text",
                    "TYPESAFE_URL": "https://openrouter.ai/api/alpha/decisions",
                    "TYPESAFE_MODEL": "typesafe/jev-1.13", "TEXT_MODEL": "inception/mercury-2.5",
                    "TEXT_MODEL_BASE_URL": "https://openrouter.ai/api/v1", "TEXT_MODEL_REASONING": "none"}
        self.assertEqual(runner.model_environment({"model_env": settings}), settings)
        for key in settings:
            missing = {name: value for name, value in settings.items() if name != key}
            with self.assertRaises(ValueError):
                runner.model_environment({"model_env": missing})
        for url in ["https://api.deepseek.com/v1", "http://openrouter.ai/api/v1",
                    "https://openrouter.ai.evil.example/api/v1", "https://user@openrouter.ai/api/v1",
                    "https://openrouter.ai/api/v1?redirect=other"]:
            with self.assertRaises(ValueError):
                runner.model_environment({"model_env": {**settings, "TEXT_MODEL_BASE_URL": url}})

    def test_reporting_credentials_never_enter_command_arguments(self):
        token = "synthetic-test-token"
        with patch.object(runner, "command") as command:
            runner.report({"github_token": token, "author": "test-owner"},
                           "release/2026/10/07-01", "a" * 40, "running")
            args, kwargs = command.call_args
            self.assertNotIn(token, repr(args))
            self.assertEqual(json.loads(kwargs["input"])["token"], token)


class ProgressTests(unittest.TestCase):
    """The release comment is updated as each setup step and journey finishes."""

    def progress(self):
        config = {"github_token": "t", "author": "qa"}
        return runner.Progress(config, "release/2026/11/03-01", "a" * 40, time.monotonic())

    def published(self, report):
        return [json.loads(call.kwargs["input"]) for call in report.call_args_list]

    def test_journeys_are_reported_as_they_start_finish_and_fail(self):
        progress = self.progress()
        with patch.object(runner, "command") as command:
            progress.feed(b"Running 12 tests using 1 worker\n\n"
                          b"[1/12] smart-tests/journeys/dom-audit.spec.ts:7:1 \xe2\x80\xba DOM audit: surfaces\n")
            progress.feed(b"[2/12] smart-tests/journeys/edit.spec.ts:12:3 \xe2\x80\xba Jev edit durability: normal\n"
                          b"    Error: {\"verdict\":\"inconclusive\"}\n")
            progress.feed(b"    at file (x.ts:1:1)\n[3/12] smart-tests/x.spec.ts:1:1 \xe2\x80\xba third\n")
        payloads = [p["progress"] for p in self.published(command)]
        self.assertEqual([p["stage"] for p in payloads], ["tests"] * 4)
        self.assertEqual(payloads[0]["journeys"], [{"title": "DOM audit: surfaces", "state": "running"}])
        self.assertEqual([j["state"] for j in payloads[1]["journeys"]], ["finished", "running"])
        self.assertEqual([j["state"] for j in payloads[2]["journeys"]], ["finished", "failed"])
        self.assertEqual([j["state"] for j in payloads[3]["journeys"]], ["finished", "failed", "running"])
        self.assertEqual(payloads[3]["total"], 12)

    def test_partial_lines_and_unrelated_output_publish_nothing(self):
        progress = self.progress()
        with patch.object(runner, "command") as command:
            progress.feed(b"[Jev] 1 actions \xc2\xb7 CLICK \xc2\xb7 681 ms\n[1/12] smart-tests/a.spec.ts:1:1 \xe2\x80\xba ti")
            self.assertEqual(command.call_count, 0)
            progress.feed(b"tle\n")
            self.assertEqual(command.call_count, 1)
            self.assertEqual(self.published(command)[0]["progress"]["journeys"][0]["title"], "title")

    def test_container_steps_are_validated_and_published_once_per_change(self):
        progress = self.progress()
        self.assertFalse(progress.steps_from(b"not json"))
        self.assertFalse(progress.steps_from(b'[{"name": 7, "seconds": 1}]'))
        self.assertTrue(progress.steps_from(b'[{"name": "dependencies", "seconds": 169.64, "detail": "installed"}]'))
        self.assertFalse(progress.steps_from(b'[{"name": "dependencies", "seconds": 169.64, "detail": "installed"}]'))
        with patch.object(runner, "command") as command:
            progress.publish()
            progress.publish()
            progress.stack_ready()
        payloads = self.published(command)
        self.assertEqual(len(payloads), 2)
        self.assertEqual(payloads[0]["progress"]["stage"], "setup")
        self.assertEqual(payloads[0]["progress"]["steps"][0]["detail"], "installed")
        self.assertEqual(payloads[1]["progress"]["steps"][1]["name"], "stack")

    def test_a_failed_progress_update_never_fails_the_job(self):
        progress = self.progress()
        progress.steps_from(b'[{"name": "build", "seconds": 20.7, "detail": ""}]')
        with patch.object(runner, "command", side_effect=subprocess.TimeoutExpired("node", 150)):
            progress.publish()
        self.assertIsNone(progress.sent)

    def test_command_streams_output_to_the_progress_parser_while_logging(self):
        seen = []
        with tempfile.TemporaryFile() as log:
            runner.command([sys.executable, "-c", "print('[1/2] a.spec.ts:1:1 › one')"], log,
                           timeout=30, on_output=seen.append)
            log.seek(0)
            self.assertIn(b"[1/2]", log.read())
        self.assertIn(b"[1/2]", b"".join(seen))


if __name__ == "__main__":
    unittest.main()


class InterruptedDrainTests(unittest.TestCase):
    """An interrupted job must never hold the queue hostage.

    A stuck job is worse than a missing report: every later PR silently stops
    being tested while the runner looks healthy.
    """

    def setUp(self):
        self.state = tempfile.TemporaryDirectory()
        self.addCleanup(self.state.cleanup)
        patcher = patch.object(webhook, "STATE", Path(self.state.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.jobs = tempfile.TemporaryDirectory()
        self.addCleanup(self.jobs.cleanup)
        patcher = patch.object(runner, "JOBS", Path(self.jobs.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def interrupt(self, age):
        with runner.database() as db:
            now = time.time()
            db.execute("INSERT INTO jobs(pr,sha,status,created,updated) VALUES(?,?,?,?,?)",
                       (716, "a" * 40, "interrupted", now - age, now - age))
            return db.execute("SELECT id,pr,sha,ref,updated FROM jobs").fetchone()

    def status(self, job_id):
        with runner.database() as db:
            return db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()[0]

    def test_a_deliverable_report_closes_the_job(self):
        job = self.interrupt(age=0)
        with patch.object(runner, "cleanup_containers"), patch.object(runner, "report"):
            runner.drain_interrupted({}, job)
        self.assertEqual(self.status(job[0]), "failed")

    def test_an_undeliverable_report_is_retried_inside_the_grace_window(self):
        job = self.interrupt(age=0)
        with patch.object(runner, "cleanup_containers"), \
             patch.object(runner, "report", side_effect=ConnectionError("github down")):
            runner.drain_interrupted({}, job)
        self.assertEqual(self.status(job[0]), "interrupted")

    def test_an_undeliverable_report_gives_up_and_frees_the_queue(self):
        job = self.interrupt(age=runner.REPORT_GRACE + 1)
        with patch.object(runner, "cleanup_containers"), \
             patch.object(runner, "report", side_effect=ConnectionError("github down")):
            runner.drain_interrupted({}, job)
        self.assertEqual(self.status(job[0]), "report-failed")

    def test_a_job_that_cannot_be_reported_never_blocks_a_later_pr(self):
        # The regression that matters: the queue keeps moving.
        job = self.interrupt(age=runner.REPORT_GRACE + 1)
        with runner.database() as db:
            db.execute("INSERT INTO jobs(pr,sha,status,created,updated) VALUES(?,?,?,?,?)",
                       (717, "b" * 40, "queued", time.time(), time.time()))
        with patch.object(runner, "cleanup_containers"), \
             patch.object(runner, "report", side_effect=ConnectionError("github down")):
            runner.drain_interrupted({}, job)
        with runner.database() as db:
            blocking = db.execute("SELECT COUNT(*) FROM jobs WHERE status='interrupted'").fetchone()[0]
        self.assertEqual(blocking, 0)
