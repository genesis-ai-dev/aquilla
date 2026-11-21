"""Run: python3 -m unittest discover -s smart-tests -p 'test_*.py'"""

import unittest

import json

from text_fallback import FALLBACK_TEXT_MODELS, post_text, post_valid_text

URL = "https://openrouter.ai/api/v1/chat/completions"
PRIMARY = "inception/mercury-2.5"


def provider(statuses):
    """A provider that answers each model with its status; 200 returns the model."""
    calls = []

    def post(url, key, body):
        calls.append(body["model"])
        status = statuses.get(body["model"], 200)
        if status != 200:
            raise RuntimeError(f"Model provider returned HTTP {status}; no action executed.")
        return {"model": body["model"], "kept": body["messages"]}

    return post, calls


class TextFallbackTests(unittest.TestCase):
    def test_a_text_model_with_no_provider_does_not_stop_the_journey(self):
        # The 2026-11 outage: the primary answered 404 and every typing attack
        # went inconclusive. The next model must answer the same request.
        post, calls = provider({PRIMARY: 404})
        result = post_text(post, URL, "key", {"model": PRIMARY, "messages": ["m"]})
        self.assertEqual(result, {"model": FALLBACK_TEXT_MODELS[0], "kept": ["m"]})
        self.assertEqual(calls, [PRIMARY, FALLBACK_TEXT_MODELS[0]])

    def test_a_healthy_primary_is_the_only_model_called(self):
        # Fallbacks must not change which model a normal run measures or pays for.
        post, calls = provider({})
        post_text(post, URL, "key", {"model": PRIMARY, "messages": []})
        self.assertEqual(calls, [PRIMARY])

    def test_when_every_model_is_refused_the_run_still_reports_the_provider_error(self):
        # The reporter classifies this exact message as "not attributable to the
        # product". Swallowing it would turn a dead helper into a product failure.
        post, calls = provider({PRIMARY: 404, **{model: 503 for model in FALLBACK_TEXT_MODELS}})
        with self.assertRaisesRegex(RuntimeError, "Model provider returned HTTP 503"):
            post_text(post, URL, "key", {"model": PRIMARY, "messages": []})
        self.assertEqual(calls, [PRIMARY, *FALLBACK_TEXT_MODELS])

    def test_a_fallback_already_used_as_the_primary_is_not_called_twice(self):
        primary = FALLBACK_TEXT_MODELS[1]
        post, calls = provider({primary: 404, FALLBACK_TEXT_MODELS[0]: 404})
        post_text(post, URL, "key", {"model": primary, "messages": []})
        self.assertEqual(calls, [primary, FALLBACK_TEXT_MODELS[0], FALLBACK_TEXT_MODELS[2]])

    def test_openrouter_model_ids_are_never_sent_to_another_provider(self):
        post, calls = provider({"deepseek-chat": 404})
        with self.assertRaises(RuntimeError):
            post_text(post, "https://api.deepseek.com/v1/chat/completions", "key",
                      {"model": "deepseek-chat", "messages": []})
        self.assertEqual(calls, ["deepseek-chat"])

    def test_a_lost_connection_is_not_retried_on_other_models(self):
        calls = []

        def post(url, key, body):
            calls.append(body["model"])
            raise RuntimeError("Model connection failed; no action executed.")

        with self.assertRaisesRegex(RuntimeError, "Model connection failed"):
            post_text(post, URL, "key", {"model": PRIMARY, "messages": []})
        self.assertEqual(calls, [PRIMARY])


def reply(content):
    return {"choices": [{"message": {"content": content}}]}


def helper(contents):
    """A text helper that answers each call with the next canned reply."""
    remaining = list(contents)
    calls = []

    def post(url, key, body):
        calls.append(body["model"])
        return reply(remaining.pop(0))

    return post, calls


class TextRetryTests(unittest.TestCase):
    BODY = {"model": PRIMARY, "messages": []}

    def test_one_unusable_reply_does_not_end_the_journey(self):
        # Upstream raises "nothing typed" on the first malformed reply, which
        # made the attack inconclusive. The second ask must reach the agent.
        for bad in ("not json", json.dumps({"text": "  "}), json.dumps({"text": "x", "note": "y"}), json.dumps(["x"])):
            post, calls = helper([bad, json.dumps({"text": "Adversarial one"})])
            result = post_valid_text(post, URL, "key", self.BODY)
            self.assertEqual(json.loads(result["choices"][0]["message"]["content"]), {"text": "Adversarial one"})
            self.assertEqual(len(calls), 2, bad)

    def test_a_usable_reply_is_never_asked_for_twice(self):
        # A second ask could return a different value than the one the run pays for and types.
        post, calls = helper([json.dumps({"text": "Adversarial one"})])
        post_valid_text(post, URL, "key", self.BODY)
        self.assertEqual(calls, [PRIMARY])

    def test_two_unusable_replies_still_reach_upstreams_own_error(self):
        # The reporter keys "not attributable to the product" on upstream's
        # message, so the bad reply must be handed back, not swallowed or looped on.
        post, calls = helper(["nope", "still nope"])
        result = post_valid_text(post, URL, "key", self.BODY)
        self.assertEqual(result, reply("still nope"))
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
