"""Pass 1 — `skills/qa-characters-punctuation.md`.

Baseline-required: this pass reports deviations from `style/characters`,
`style/punctuation` and `style/quotations` and nothing else. With no baseline it
refuses to run rather than inventing an approved set, which is the skill file's
explicit instruction.
"""

from __future__ import annotations

import unicodedata
from collections import Counter

from ..baseline import Baseline
from ..corpus import Corpus, Verse, tokenize
from ..findings import Confidence, Finding, FindingSet, Severity, Verifier

SKILL = "qa-characters-punctuation"
_VERIFIER = Verifier.PROOF_READER

#: Look-alike pairs the skill file names, as {character: its approved twin}.
LOOKALIKES: dict[str, str] = {
    "'": "’",      # straight apostrophe → right single quote
    '"': "”",      # straight double quote → right double quote
    "-": "–",      # hyphen-minus → en dash
    "о": "o",      # Cyrillic o → Latin o
    "а": "a",      # Cyrillic a → Latin a
    "е": "e",      # Cyrillic e → Latin e
}

#: Bracket pairs always checked, plus whatever `style/quotations` adds.
BASE_PAIRS: tuple[tuple[str, str], ...] = (("(", ")"), ("[", "]"))

#: Invisible / control code points qa-bootstrap-inventories.md calls outliers.
INVISIBLE: frozenset[str] = frozenset(
    {"​", "‌", "‍", "﻿", "­"}
)


def run(corpus: Corpus, baseline: Baseline) -> FindingSet:
    out = FindingSet(SKILL)
    translated = [v for v in corpus if v.has_target]
    if not baseline.characters:
        out.skip(
            "all checks",
            "no verified style/characters baseline — run qa-bootstrap-inventories first "
            "(qa-characters-punctuation.md → Baseline). Never invent an approved set.",
        )
        return out

    unknown: Counter[str] = Counter()
    unknown_refs: dict[str, list[Verse]] = {}
    for verse in translated:
        for char in verse.target:
            if char.isspace() or char in baseline.characters:
                continue
            unknown[char] += 1
            unknown_refs.setdefault(char, []).append(verse)

    out.log(f"cells checked: {len(translated)}; characters outside the baseline: {len(unknown)}")
    _unknown_characters(unknown, unknown_refs, baseline, out)
    for verse in translated:
        _mixed_script_words(verse, out)
        _spacing(verse, baseline, out)
        _sentence_end(verse, baseline, out)
        _abbreviations(verse, baseline, out)
    _pairs(translated, baseline, out)
    return out


def _unknown_characters(
    unknown: Counter[str], refs: dict[str, list[Verse]], baseline: Baseline, out: FindingSet
) -> None:
    for char, count in unknown.most_common():
        verses = refs[char][:5]
        name = unicodedata.name(char, "unnamed")
        code = f"U+{ord(char):04X}"
        lookalike = LOOKALIKES.get(char)
        if lookalike and lookalike in baseline.characters:
            check, severity = "Wrong code point", Severity.MAJOR
            found = f"{char!r} ({code} {name}) used where {lookalike!r} is approved"
            fix = f"replace {char!r} with {lookalike!r} (autofix candidate)"
        elif char in INVISIBLE or unicodedata.category(char) in {"Cc", "Cf"}:
            check, severity = "Invisible or control character", Severity.CRITICAL
            found = f"{code} {name} appears {count}×"
            fix = "remove the invisible character"
        else:
            check, severity = "Character not in the baseline", Severity.MAJOR
            found = f"{char!r} ({code} {name}) appears {count}×, not in style/characters"
            fix = "remove it, or raise a Query so the proof-reader can add it to the baseline"
        out.add(
            Finding(
                skill=SKILL,
                check=check,
                severity=severity,
                confidence=Confidence.HIGH,
                refs=tuple(v.ref_label for v in verses),
                cell_ids=tuple(v.cell_id for v in verses),
                file_id=verses[0].file_id if verses else "",
                found=found,
                evidence=f"{count} occurrence(s); verified baseline holds {len(baseline.characters)} characters",
                proposed_fix=fix,
                verifier=_VERIFIER,
            )
        )


def _script_of(char: str) -> str:
    """Coarse script name from the Unicode character name's first word."""
    name = unicodedata.name(char, "")
    return name.split(" ", 1)[0] if name else ""


def _mixed_script_words(verse: Verse, out: FindingSet) -> None:
    for word in tokenize(verse.target):
        scripts = {_script_of(c) for c in word if c.isalpha()}
        scripts.discard("")
        if len(scripts) > 1:
            out.add(
                Finding(
                    skill=SKILL,
                    check="Mixed-script word",
                    severity=Severity.CRITICAL,
                    confidence=Confidence.HIGH,
                    refs=(verse.ref_label,),
                    cell_ids=(verse.cell_id,),
                    file_id=verse.file_id,
                    found=f"{word!r} mixes {', '.join(sorted(scripts))}",
                    evidence="a look-alike from another script inside one word",
                    proposed_fix="retype the word in one script",
                    verifier=_VERIFIER,
                )
            )
            return


def _spacing_pattern(text: str, position: int) -> str:
    before = text[position - 1] if position > 0 else ""
    after = text[position + 1] if position + 1 < len(text) else ""
    return f"{_slot(before)}|{_slot(after)}"


def _slot(char: str) -> str:
    if char == "":
        return "edge"
    if char == " ":
        return "nbsp"
    if char.isspace():
        return "space"
    return "none"


def _spacing(verse: Verse, baseline: Baseline, out: FindingSet) -> None:
    for mark, approved in baseline.punctuation.items():
        if approved == "any" or len(mark) != 1:
            continue
        for position, char in enumerate(verse.target):
            if char != mark:
                continue
            actual = _spacing_pattern(verse.target, position)
            if actual == approved or "edge" in actual:
                continue
            out.add(
                Finding(
                    skill=SKILL,
                    check="Spacing deviates from the baseline",
                    severity=Severity.MINOR,
                    confidence=Confidence.HIGH,
                    refs=(verse.ref_label,),
                    cell_ids=(verse.cell_id,),
                    file_id=verse.file_id,
                    found=f"{mark!r} has spacing {actual}",
                    evidence=f"style/punctuation approves {approved}",
                    proposed_fix=f"respace {mark!r} to {approved}",
                    verifier=_VERIFIER,
                )
            )
            break


def _sentence_end(verse: Verse, baseline: Baseline, out: FindingSet) -> None:
    ends = [m for m in baseline.punctuation if m in {".", "?", "!", "؟", "。"}]
    if not ends or not verse.has_source:
        return
    source_end = verse.source.rstrip()[-1:] if verse.source.strip() else ""
    if source_end not in {".", "?", "!"}:
        return
    if verse.target.rstrip()[-1:] in ends:
        return
    out.add(
        Finding(
            skill=SKILL,
            check="End punctuation",
            severity=Severity.MINOR,
            confidence=Confidence.HIGH,
            refs=(verse.ref_label,),
            cell_ids=(verse.cell_id,),
            file_id=verse.file_id,
            found="the source verse ends a sentence; the target does not end with an approved mark",
            evidence=f"approved end marks: {' '.join(ends)}; overlaps Aquilla's End punctuation",
            proposed_fix="add the approved sentence-end mark",
            verifier=_VERIFIER,
        )
    )


def _abbreviations(verse: Verse, baseline: Baseline, out: FindingSet) -> None:
    text = verse.target
    for position in range(len(text) - 1):
        if text[position] != "." or not text[position + 1 :][:1].islower():
            continue
        start = position
        while start > 0 and (text[start - 1].isalnum()):
            start -= 1
        token = text[start:position]
        if not token or token in baseline.abbreviations:
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Unapproved abbreviation",
                severity=Severity.QUERY,
                confidence=Confidence.MEDIUM,
                refs=(verse.ref_label,),
                cell_ids=(verse.cell_id,),
                file_id=verse.file_id,
                found=f"{token!r} followed by '.' then a lowercase letter",
                evidence="not in the verified abbreviation list in style/punctuation",
                proposed_fix="confirm it is an abbreviation and add it to the baseline, or fix the sentence break",
                verifier=_VERIFIER,
            )
        )
        return


def _pairs(verses: list[Verse], baseline: Baseline, out: FindingSet) -> None:
    """Unmatched pairs and quotation levels, across consecutive cells.

    Speech spans verses, so the counter is carried across the scope in order and
    only reported where it is still open at the end of a chapter — otherwise
    every verse inside a quotation would be a finding.
    """
    pairs = list(BASE_PAIRS) + [q for q in baseline.quotations if q[0] != q[1]]
    for opening, closing in pairs:
        depth = 0
        opened_at: Verse | None = None
        chapter: int | None = None
        for verse in verses:
            if verse.chapter != chapter:
                if depth > 0 and opened_at is not None:
                    _unmatched(out, opened_at, opening, closing, depth)
                depth, opened_at, chapter = 0, None, verse.chapter
            for char in verse.target:
                if char == opening:
                    if depth == 0:
                        opened_at = verse
                    depth += 1
                elif char == closing:
                    depth = max(0, depth - 1)
            if depth > len(pairs) + 2:
                _unmatched(out, opened_at or verse, opening, closing, depth)
                depth, opened_at = 0, None
        if depth > 0 and opened_at is not None:
            _unmatched(out, opened_at, opening, closing, depth)


def _unmatched(out: FindingSet, verse: Verse, opening: str, closing: str, depth: int) -> None:
    out.add(
        Finding(
            skill=SKILL,
            check="Unmatched pair",
            severity=Severity.MAJOR,
            confidence=Confidence.HIGH,
            refs=(verse.ref_label,),
            cell_ids=(verse.cell_id,),
            file_id=verse.file_id,
            found=f"{opening!r} opened here is never closed with {closing!r} in this chapter",
            evidence=f"{depth} unclosed {opening!r} at the end of the chapter",
            proposed_fix=f"close the pair with {closing!r}, or remove the stray {opening!r}",
            verifier=_VERIFIER,
        )
    )
