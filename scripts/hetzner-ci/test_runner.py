import io
import json
import subprocess
import sys
import unittest
from unittest.mock import patch
import runner


class RunnerTests(unittest.TestCase):
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
        with patch.object(runner, "current") as current:
            for job in [(1, True, "a" * 40), (1, -1, "a" * 40), (1, 716, "main;whoami")]:
                with self.assertRaises(ValueError):
                    runner.execute({}, job)
            current.assert_not_called()

    def test_stale_jobs_do_not_download_or_start_containers(self):
        with patch.object(runner, "current", return_value=False), patch.object(runner, "command") as command:
            self.assertEqual(runner.execute({}, (1, 716, "a" * 40)), "superseded")
            command.assert_not_called()

    def test_github_revalidation_rejects_forks_and_new_heads(self):
        pull = {"state": "open", "draft": False,
                "head": {"sha": "a" * 40, "repo": {"id": runner.REPO_ID}}}
        with patch.object(runner, "github", return_value=pull):
            self.assertTrue(runner.current({}, 716, "a" * 40))
            self.assertFalse(runner.current({}, 716, "b" * 40))
            pull["head"]["repo"]["id"] = 1
            self.assertFalse(runner.current({}, 716, "a" * 40))

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
            runner.report({"github_token": token, "author": "test-owner"}, 716, "a" * 40, "running")
            args, kwargs = command.call_args
            self.assertNotIn(token, repr(args))
            self.assertEqual(json.loads(kwargs["input"])["token"], token)


if __name__ == "__main__":
    unittest.main()
