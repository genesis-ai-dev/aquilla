import copy
import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import webhook


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

    def test_valid_pull(self):
        self.assertEqual(webhook.parse_event("pull_request", pull()), (716, "a" * 40))

    def test_rejected_identity(self):
        for key, value in [("number", True), ("number", "716"), ("number", -1)]:
            data = pull()
            data[key] = value
            with self.assertRaises(ValueError):
                webhook.parse_event("pull_request", data)
        data = pull()
        data["repository"]["id"] = 1
        with self.assertRaises(ValueError):
            webhook.parse_event("pull_request", data)
        for sha in ["main", "a" * 39, "a" * 40 + ";bad", None]:
            data = pull()
            data["pull_request"]["head"]["sha"] = sha
            with self.assertRaises(ValueError):
                webhook.parse_event("pull_request", data)

    def test_ignored(self):
        data = pull()
        variants = [copy.deepcopy(data) for _ in range(4)]
        variants[0]["pull_request"]["head"]["repo"]["id"] = 1
        variants[1]["pull_request"]["draft"] = True
        variants[2]["pull_request"]["state"] = "closed"
        variants[3]["action"] = "edited"
        for variant in variants:
            self.assertIsNone(webhook.parse_event("pull_request", variant))
        self.assertIsNone(webhook.parse_event("ping", {}))

    def test_durable_deduplication_and_bound(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(webhook, "STATE", Path(directory)):
            self.assertEqual(webhook.enqueue(716, "a" * 40), "queued")
            self.assertEqual(webhook.enqueue(716, "a" * 40), "duplicate")
            for number in range(1, 100):
                webhook.enqueue(number, "b" * 40)
            with self.assertRaises(OverflowError):
                webhook.enqueue(1000, "c" * 40)
            with webhook.database() as db:
                db.execute("UPDATE jobs SET status='completed' WHERE pr=716")
            self.assertEqual(webhook.enqueue(716, "a" * 40), "duplicate")


if __name__ == "__main__":
    unittest.main()
