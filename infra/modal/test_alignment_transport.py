import socket
import unittest
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from alignment_transport import pinned_target, fetch_audio, post_result
from alignment_job import execute_alignment_job, accept_alignment_job


class PinnedTargetTests(unittest.TestCase):
    def test_entrypoint_authenticates_before_validating_or_spawning(self):
        spawn = MagicMock()
        with patch("alignment_job.pinned_target") as validate:
            with self.assertRaises(PermissionError):
                accept_alignment_job({"secret": "wrong"}, "secret", spawn)
        validate.assert_not_called()
        spawn.assert_not_called()

    def test_entrypoint_validates_and_spawns_once(self):
        spawn = MagicMock()
        payload = {
            "secret": "secret", "jobId": "job-1", "script": "Known wording",
            "language": "en", "audioUrl": "https://example.com/audio",
            "callbackUrl": "https://example.com/callback",
        }
        with patch("alignment_job.pinned_target") as validate:
            result = accept_alignment_job(payload, "secret", spawn)
        self.assertEqual(validate.call_count, 2)
        spawn.assert_called_once_with(
            "job-1", payload["audioUrl"], payload["callbackUrl"],
            "Known wording", "en",
        )
        self.assertEqual(result, {"accepted": True, "jobId": "job-1"})

    def test_entrypoint_rejects_invalid_script_or_language(self):
        for script, language in [(" ", "en"), ("Known", "en-US"),
                                 ("x" * 200001, "en"), ("Known", "")]:
            with self.subTest(language=language, script_length=len(script)):
                spawn = MagicMock()
                with self.assertRaises(ValueError):
                    accept_alignment_job({
                        "secret": "secret", "jobId": "job-1", "script": script,
                        "language": language, "audioUrl": "https://example.com/a",
                        "callbackUrl": "https://example.com/c",
                    }, "secret", spawn)
                spawn.assert_not_called()

    def test_job_publishes_actual_model_result(self):
        fetch = MagicMock(return_value=b"source-audio")
        result = {"method": "ctc-forced-alignment", "segments": []}
        align = MagicMock(return_value=result)
        post = MagicMock()
        execute_alignment_job(
            "job", "audio-url", "callback-url", "Known wording", "en",
            "secret", fetch_audio=fetch, align=align, post_result=post,
        )
        align.assert_called_once_with(b"source-audio", "Known wording", "en")
        post.assert_called_once_with("callback-url", "secret", {
            "jobId": "job", "status": "done", "result": result,
        })

    def test_model_failure_reports_failure_without_source_data(self):
        post = MagicMock()
        execute_alignment_job(
            "job", "audio-url", "callback-url", "Private wording", "en",
            "secret", fetch_audio=MagicMock(return_value=b"source-audio"),
            align=MagicMock(side_effect=RuntimeError("Private wording")),
            post_result=post,
        )
        payload = post.call_args.args[2]
        self.assertEqual(payload["status"], "failed")
        self.assertNotIn("Private wording", str(payload))

    def test_callback_failure_propagates_without_false_model_failure(self):
        post = MagicMock(side_effect=RuntimeError("callback unavailable"))
        with self.assertRaisesRegex(RuntimeError, "callback unavailable"):
            execute_alignment_job(
                "job", "audio-url", "callback-url", "Known", "en", "secret",
                fetch_audio=MagicMock(return_value=b"audio"),
                align=MagicMock(return_value={"segments": []}), post_result=post,
            )
        self.assertEqual(post.call_count, 1)

    def test_audio_redirect_to_private_host_is_rejected_before_request(self):
        client = MagicMock()
        client.__enter__.return_value = client
        response = client.stream.return_value.__enter__.return_value
        response.is_redirect = True
        response.headers = {"location": "https://localhost/private"}
        httpx = SimpleNamespace(Client=MagicMock(return_value=client))
        with patch.dict("sys.modules", {"httpx": httpx}), patch(
            "alignment_transport.socket.getaddrinfo", return_value=[
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
            ],
        ):
            with self.assertRaises(ValueError):
                fetch_audio("https://example.com/audio")
        self.assertEqual(client.stream.call_count, 1)
        self.assertEqual(client.stream.call_args.args[1], "https://8.8.8.8/audio")

    def test_streamed_audio_stops_at_size_limit(self):
        client = MagicMock()
        client.__enter__.return_value = client
        response = client.stream.return_value.__enter__.return_value
        response.is_redirect = False
        response.iter_bytes.return_value = iter([b"123", b"456"])
        httpx = SimpleNamespace(Client=MagicMock(return_value=client))
        with patch.dict("sys.modules", {"httpx": httpx}), patch(
            "alignment_transport.pinned_target",
            return_value=("https://8.8.8.8/audio", "example.com", "example.com"),
        ), patch("alignment_transport.MAX_AUDIO_BYTES", 5):
            with self.assertRaisesRegex(ValueError, "upload limit"):
                fetch_audio("https://example.com/audio")

    def test_callback_pins_address_and_never_follows_redirects(self):
        client = MagicMock()
        client.__enter__.return_value = client
        client.post.return_value.is_redirect = True
        httpx = SimpleNamespace(Client=MagicMock(return_value=client))
        payload = {"jobId": "job", "status": "done"}
        with patch.dict("sys.modules", {"httpx": httpx}), patch(
            "alignment_transport.pinned_target",
            return_value=("https://8.8.8.8/callback", "example.com", "example.com"),
        ):
            with self.assertRaisesRegex(ValueError, "redirect"):
                post_result("https://example.com/callback", "test-secret", payload)
        client.post.assert_called_once_with(
            "https://8.8.8.8/callback",
            headers={"Host": "example.com", "X-Alignment-Secret": "test-secret"},
            extensions={"sni_hostname": "example.com"}, json=payload,
        )
        self.assertFalse(httpx.Client.call_args.kwargs["follow_redirects"])

    def test_https_public_target_returns_pinned_url_host_and_sni(self):
        with patch("alignment_transport.socket.getaddrinfo", return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
        ]):
            url, host, sni = pinned_target("https://example.com/audio.mp3")
        self.assertEqual(url, "https://8.8.8.8/audio.mp3")
        self.assertEqual(host, "example.com")
        self.assertEqual(sni, "example.com")

    def test_localhost_http_and_credentialed_urls_raise_value_error(self):
        for url in [
            "https://localhost/audio.mp3",
            "http://example.com/audio.mp3",
            "https://user:pass@example.com/audio.mp3",
        ]:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    pinned_target(url)

    def test_private_or_empty_dns_answers_raise_value_error(self):
        for answers in [
            [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 443))],
            [],
        ]:
            with self.subTest(answers=answers):
                with patch("alignment_transport.socket.getaddrinfo", return_value=answers):
                    with self.assertRaises(ValueError):
                        pinned_target("https://example.com/audio.mp3")

    def test_mixed_public_and_private_dns_answers_fail(self):
        answers = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 443)),
        ]
        with patch("alignment_transport.socket.getaddrinfo", return_value=answers):
            with self.assertRaises(ValueError):
                pinned_target("https://example.com/audio.mp3")


if __name__ == "__main__":
    unittest.main()
