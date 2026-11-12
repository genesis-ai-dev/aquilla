"""Pass 1 — `skills/qa-capitalization-numbers.md`.

The numbers half is the part that changes meaning, so it is the part that is
purely arithmetic: digits are folded across scripts (40 = ٤٠ = ၄၀) and the
multiset of numbers in the source verse is compared with the target's.

Capitalization is skipped outright on a caseless script, and the run says so in
"Not checked" rather than silently passing.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter

from ..baseline import Baseline
from ..corpus import Corpus, Verse, tokenize
from ..findings import Confidence, Finding, FindingSet, Severity, Verifier

SKILL = "qa-capitalization-numbers"
_VERIFIER = Verifier.PROOF_READER

#: Any run of Unicode decimal digits, in any script.
_NUMBER = re.compile(r"[^\W\d_]*(\d+)[^\W\d_]*", re.UNICODE)
_DIGITS = re.compile(r"\d+")

#: Immediately repeated word, optionally across a punctuation mark.
_REPEAT = re.compile(r"\b(\w+)\b([\s,;:–—-]+)\1\b", re.UNICODE | re.IGNORECASE)

#: Size bands qa-bootstrap-inventories.md → Conventions uses.
BANDS: tuple[tuple[str, int, int], ...] = (("1-10", 1, 10), ("11-100", 11, 100), (">100", 101, 10**9))


def run(corpus: Corpus, baseline: Baseline) -> FindingSet:
    out = FindingSet(SKILL)
    translated = [v for v in corpus if v.has_target]
    out.log(f"cells checked: {len(translated)}")

    if baseline.cased_script:
        for verse in translated:
            _recurring_words(verse, baseline, out)
            _name_case(verse, baseline, out)
        _new_inconsistencies(translated, baseline, out)
    else:
        out.skip(
            "Capitalization",
            "the project's script has no upper/lower case, per the verified style/characters "
            "baseline (qa-capitalization-numbers.md → Baseline).",
        )

    for verse in translated:
        _numbers(verse, baseline, out)
        _repeated_words(verse, out)
    return out


# -- capitalization ---------------------------------------------------------


def _recurring_words(verse: Verse, baseline: Baseline, out: FindingSet) -> None:
    for word, approved in baseline.conventions.items():
        if word == approved:
            continue
        pattern = re.compile(rf"(?<![^\W\d_]){re.escape(word)}(?![^\W\d_])")
        if not pattern.search(verse.target):
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Recurring word in the non-approved case",
                severity=Severity.MAJOR,
                confidence=Confidence.HIGH,
                refs=(verse.ref_label,),
                cell_ids=(verse.cell_id,),
                file_id=verse.file_id,
                found=f"{word!r} written where style/conventions approves {approved!r}",
                evidence="verified style/conventions baseline",
                proposed_fix=f"write {approved!r} (autofix candidate)",
                verifier=_VERIFIER,
            )
        )


def _name_case(verse: Verse, baseline: Baseline, out: FindingSet) -> None:
    for word in tokenize(verse.target):
        approved = baseline.names.get(word) or baseline.names.get(word.capitalize())
        if approved and word != approved and word.lower() == approved.lower():
            out.add(
                Finding(
                    skill=SKILL,
                    check="Name case differs from the termbase",
                    severity=Severity.MAJOR,
                    confidence=Confidence.HIGH,
                    refs=(verse.ref_label,),
                    cell_ids=(verse.cell_id,),
                    file_id=verse.file_id,
                    found=f"{word!r} where the recorded spelling is {approved!r}",
                    evidence="verified glossary/names baseline",
                    proposed_fix=f"write {approved!r}",
                    verifier=_VERIFIER,
                )
            )
            return


def _new_inconsistencies(verses: list[Verse], baseline: Baseline, out: FindingSet) -> None:
    """Words appearing both capitalized and lowercase mid-sentence, off-baseline.

    A Query to the mentor with counts per form — the skill file is explicit that
    this is not the proof-reader's call.
    """
    forms: dict[str, Counter[str]] = {}
    for verse in verses:
        words = tokenize(verse.target)
        for position, word in enumerate(words):
            if position == 0 or not word[:1].isalpha():
                continue  # sentence-initial case is a different check
            forms.setdefault(word.lower(), Counter())[word] += 1
    for lower, counter in forms.items():
        if len(counter) < 2 or lower in {k.lower() for k in baseline.conventions}:
            continue
        cased = [w for w in counter if w[:1].isupper()]
        if not cased or len(counter) > 4:
            continue
        spread = ", ".join(f"{form} ×{count}" for form, count in counter.most_common())
        out.add(
            Finding(
                skill=SKILL,
                check="New capitalization inconsistency",
                severity=Severity.QUERY,
                confidence=Confidence.MEDIUM,
                found=f"{lower!r} appears mid-sentence in {len(counter)} cases: {spread}",
                evidence="not in the verified style/conventions baseline",
                proposed_fix="the mentor decides the convention; then add it to style/conventions",
                verifier=Verifier.MENTOR,
            )
        )


# -- numbers ---------------------------------------------------------------


def fold_digits(text: str) -> str:
    """Map every Unicode decimal digit to its ASCII value (40 = ٤٠ = ၄၀)."""
    return "".join(str(unicodedata.decimal(c)) if c.isdigit() else c for c in text)


def _number_multiset(text: str) -> Counter[str]:
    return Counter(_DIGITS.findall(fold_digits(text)))


def _numbers(verse: Verse, baseline: Baseline, out: FindingSet) -> None:
    if not verse.has_source:
        return
    source_numbers = _number_multiset(verse.source)
    target_numbers = _number_multiset(verse.target)
    missing = source_numbers - target_numbers
    added = target_numbers - source_numbers
    if missing or added:
        out.add(
            Finding(
                skill=SKILL,
                check="Number mismatch",
                severity=Severity.MAJOR,
                confidence=Confidence.HIGH,
                refs=(verse.ref_label,),
                cell_ids=(verse.cell_id,),
                file_id=verse.file_id,
                found=(
                    f"source numbers {sorted(source_numbers.elements())} vs "
                    f"target {sorted(target_numbers.elements())}"
                ),
                evidence=(
                    f"missing {sorted(missing.elements()) or '—'}, "
                    f"added {sorted(added.elements()) or '—'} (digits folded across scripts)"
                ),
                proposed_fix="check the number against the source verse — a changed number changes the meaning",
                verifier=_VERIFIER,
            )
        )
    _mixed_digit_scripts(verse, out)
    _number_style(verse, baseline, target_numbers, out)


def _mixed_digit_scripts(verse: Verse, out: FindingSet) -> None:
    for match in re.finditer(r"\d+", verse.target):
        scripts = {unicodedata.name(c, "").split(" ", 1)[0] for c in match.group(0)}
        if len(scripts) > 1:
            out.add(
                Finding(
                    skill=SKILL,
                    check="Mixed digit scripts in one number",
                    severity=Severity.MAJOR,
                    confidence=Confidence.HIGH,
                    refs=(verse.ref_label,),
                    cell_ids=(verse.cell_id,),
                    file_id=verse.file_id,
                    found=f"{match.group(0)!r} mixes {', '.join(sorted(scripts))}",
                    evidence="one number written in two digit scripts",
                    proposed_fix="retype the number in the project's digit script",
                    verifier=_VERIFIER,
                )
            )
            return


def _band(value: int) -> str:
    for name, low, high in BANDS:
        if low <= value <= high:
            return name
    return ">100"


def _number_style(verse: Verse, baseline: Baseline, numbers: Counter[str], out: FindingSet) -> None:
    if not baseline.number_style:
        return
    for raw in numbers:
        band = _band(int(raw))
        style = baseline.number_style.get(band)
        if style != "words":
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Number written against the verified style",
                severity=Severity.MINOR,
                confidence=Confidence.HIGH,
                refs=(verse.ref_label,),
                cell_ids=(verse.cell_id,),
                file_id=verse.file_id,
                found=f"{raw} written as digits",
                evidence=f"style/conventions sets the {band} band to words",
                proposed_fix=f"write {raw} as a word",
                verifier=_VERIFIER,
            )
        )
        return


# -- repeated words --------------------------------------------------------


def _repeated_words(verse: Verse, out: FindingSet) -> None:
    for match in _REPEAT.finditer(verse.target):
        word = match.group(1)
        # Intentional in the source at this verse (Saul, Saul; Truly, truly) →
        # dropped, exactly as the skill file says.
        if _REPEAT.search(verse.source) and word.lower() in verse.source.lower():
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Repeated word",
                severity=Severity.MINOR,
                confidence=Confidence.HIGH,
                refs=(verse.ref_label,),
                cell_ids=(verse.cell_id,),
                file_id=verse.file_id,
                found=f"{word!r} immediately repeated",
                evidence="the source verse does not repeat it at this verse",
                proposed_fix="delete the repetition, unless it is deliberate emphasis",
                verifier=_VERIFIER,
            )
        )
        return
