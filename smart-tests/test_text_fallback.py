"""Run: python3 -m unittest discover -s smart-tests -p 'test_*.py'"""

import unittest

from text_fallback import FALLBACK_TEXT_MODELS, post_text

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


if __name__ == "__main__":
    unittest.main()
