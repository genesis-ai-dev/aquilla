import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import webhook


REF = "release/2026/10/07-01"


def push(ref="refs/heads/" + REF, sha="a" * 40):
    return {"repository": {"id": webhook.REPO_ID}, "ref": ref, "after": sha, "deleted": False}


def pull():
    return {"repository": {"id": webhook.REPO_ID}, "action": "synchronize",
            "number": 716, "pull_request": {"state": "open", "draft": False,
                "head": {"sha": "a" * 40, "repo": {"id": webhook.REPO_ID}}}}


class WebhookTests(unittest.TestCase):
    def test_signature_and_tampering(self):
        body = json.dumps(pull()).encode()
        secret = "test-only-secret"
        signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        self.assertTrue(webhook.valid_signature(body, signature, secret))
        self.assertFalse(webhook.valid_signature(body + b" ", signature, secret))
        self.assertFalse(webhook.valid_signature(body, None, secret))
        self.assertFalse(webhook.valid_signature(body, "sha256=bad", secret))

    def test_release_push_starts_a_run(self):
        self.assertEqual(webhook.parse_event("push", push()), (REF, "a" * 40))

    def test_pull_requests_do_not_run(self):
        self.assertIsNone(webhook.parse_event("pull_request", pull()))
        self.assertIsNone(webhook.parse_event("ping", {}))

    def test_rejected_identity(self):
        data = push()
        data["repository"]["id"] = 1
        with self.assertRaises(ValueError):
            webhook.parse_event("push", data)
        for sha in ["main", "a" * 39, "a" * 40 + ";bad", None]:
            data = push(sha=sha)
            with self.assertRaises(ValueError):
                webhook.parse_event("push", data)

    def test_ignored(self):
        self.assertIsNone(webhook.parse_event("push", push(ref="refs/heads/dev")))
        self.assertIsNone(webhook.parse_event("push", push(ref="refs/heads/release/not-a-cut")))
        self.assertIsNone(webhook.parse_event("push", push(ref="refs/tags/2026.10.07.01")))
        deleted = push()
        deleted["deleted"] = True
        deleted["after"] = "0" * 40
        self.assertIsNone(webhook.parse_event("push", deleted))

    def test_durable_deduplication_and_bound(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(webhook, "STATE", Path(directory)):
            self.assertEqual(webhook.enqueue(REF, "a" * 40), "queued")
            self.assertEqual(webhook.enqueue(REF, "a" * 40), "duplicate")
            for number in range(1, 100):
                day = f"{(number % 28) + 1:02d}"
                month = f"{(number // 28) + 1:02d}"
                webhook.enqueue(f"release/2026/{month}/{day}-{number % 100:02d}", f"{number:040x}")
            with self.assertRaises(OverflowError):
                webhook.enqueue("release/2026/12/31-01", "c" * 40)
            with webhook.database() as db:
                db.execute("UPDATE jobs SET status='completed' WHERE sha=?", ("a" * 40,))
            self.assertEqual(webhook.enqueue(REF, "a" * 40), "duplicate")


if __name__ == "__main__":
    unittest.main()
