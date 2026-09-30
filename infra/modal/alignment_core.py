"""Convert acoustic word evidence into the user's paragraph segments."""
from __future__ import annotations

import re
import math
import unicodedata
from array import array
from numbers import Real


def _tokens(text):
    text = unicodedata.normalize("NFKC", text).lower()
    return [word.replace("'", "").replace("’", "")
            for word in re.findall(r"[^\W_]+(?:['’][^\W_]+)*", text)]


def _matches(expected, actual):
    if expected == actual:
        return {i: i for i in range(len(expected))}
    width = len(actual) + 1
    size = (len(expected) + 1) * width
    if size > 4_000_000:
        raise ValueError("Alignment wording differs too much; review shorter sections.")
    scores = array("I", [0]) * size
    for i in range(len(expected) - 1, -1, -1):
        for j in range(len(actual) - 1, -1, -1):
            scores[i * width + j] = (
                1 + scores[(i + 1) * width + j + 1]
                if expected[i] == actual[j]
                else max(scores[(i + 1) * width + j], scores[i * width + j + 1])
            )
    matches = {}
    i = j = 0
    while i < len(expected) and j < len(actual):
        if expected[i] == actual[j]:
            matches[i] = j
            i += 1
            j += 1
        elif scores[(i + 1) * width + j] > scores[i * width + j + 1]:
            i += 1
        else:
            j += 1
    return matches


def _finite(value):
    return isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)


def build_alignment_result(script, aligned_words, duration_seconds):
    paragraphs = [text.strip() for text in re.split(r"\r?\n\s*\r?\n", script.strip())
                  if text.strip()]
    paragraph_words = [_tokens(text) for text in paragraphs]
    expected = [word for words in paragraph_words for word in words]
    evidence = [(token, word) for word in aligned_words
                for token in _tokens(word.get("word", ""))]
    matches = _matches(expected, [token for token, _ in evidence])
    segments = []
    offset = 0
    for text, tokens in zip(paragraphs, paragraph_words):
        count = len(tokens)
        words = [evidence[matches[i]][1] for i in range(offset, offset + count)
                 if i in matches]
        words = [word for word in words
                 if _finite(word.get("start")) and _finite(word.get("end"))
                 and 0 <= word["start"] < word["end"] <= duration_seconds]
        if any(current["start"] < previous["start"]
               or current["end"] < previous["end"]
               for previous, current in zip(words, words[1:])):
            # Unordered model evidence cannot supply a trustworthy span.
            words = []
        offset += count
        confidence = sum(float(word["score"]) if _finite(word.get("score"))
                         and 0 <= word["score"] <= 1 else 0
                         for word in words) / len(words) if words else 0
        complete = count > 0 and len(words) == count
        segments.append({
            "text": text,
            "start": float(words[0]["start"]) if words else None,
            "end": float(words[-1]["end"]) if words else None,
            "confidence": confidence,
            "matchedWords": len(words),
            "totalWords": count,
            "needsReview": not complete or confidence < 0.8,
            "status": "matched" if complete else "partial" if words else "unmatched",
        })
    return {"method": "ctc-forced-alignment", "segments": segments}
