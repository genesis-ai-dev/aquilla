"""Fallback models for Jev's text helper (the small model that writes field values).

One text model with no provider behind it turned every attack that types into
"inconclusive" for ten days (2026-11-08 onwards: OpenRouter answered HTTP 404
for `inception/mercury-2.5`), and the run still reported no failures. The
decision model has no fallback on purpose: a different decision model is a
different test. The text helper only supplies a field value that the oracle
checks afterwards, so any capable fast model will do.

No Jev import here, so this file is testable without the pinned environment.
"""

import re

# Tried in order after TEXT_MODEL. Small, fast, JSON-mode models from three
# different providers, so one provider leaving does not take the helper down.
FALLBACK_TEXT_MODELS = (
    "google/gemini-3.5-flash-lite",
    "openai/gpt-5.4-nano",
    "anthropic/claude-haiku-5.5",
)

# The ids above are OpenRouter's. Another provider would not know them.
OPENROUTER = "https://openrouter.ai/"

PROVIDER_ERROR = re.compile(r"Model provider returned HTTP \d{3}; no action executed\.")


def text_models(url, primary):
    if not url.startswith(OPENROUTER):
        return [primary]
    return [primary, *(model for model in FALLBACK_TEXT_MODELS if model != primary)]


def post_text(post, url, key, body):
    """Send the text request to each model in turn until a provider answers.

    `post` raises RuntimeError("Model provider returned HTTP <status>; ...")
    when a provider refuses. Anything else (no connection, a malformed reply)
    is not a reason to pay for another model, so it propagates at once.
    """
    models = text_models(url, body["model"])
    for index, model in enumerate(models):
        try:
            return post(url, key, {**body, "model": model})
        except RuntimeError as error:
            if not PROVIDER_ERROR.fullmatch(str(error)) or index == len(models) - 1:
                raise
