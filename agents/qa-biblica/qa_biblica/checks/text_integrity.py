"""Pass 1 — `skills/qa-text-integrity.md`. Clean plain text.

The skill file notes where each check overlaps an Aquilla built-in (*Placeholder
integrity*, *Untranslated words*, *Extra whitespace*, *Corrupted characters*)
and says to report it once. `builtin_overlap` on each finding names the built-in,
so the report can cite it by check name instead of re-describing it — which is
what qa-run-book.md → Procedure 2 asks for.
"""

from __future__ import annotations

import re
import unicodedata

from ..corpus import Corpus, Verse, ngrams, normalize, sentences, tokenize
from ..findings import Confidence, Finding, FindingSet, Severity, Verifier

SKILL = "qa-text-integrity"
_VERIFIER = Verifier.POST_EDITOR

#: Each pattern is (check name, regex, severity, the Aquilla built-in it overlaps).
_STRAY_PATTERNS: tuple[tuple[str, re.Pattern[str], Severity, str], ...] = (
    ("Backslash code", re.compile(r"\\[a-z]{1,3}\d?\b"), Severity.CRITICAL, ""),
    ("HTML/XML tag", re.compile(r"</?[A-Za-z][A-Za-z0-9]*\s*/?>|&[a-z]{2,6};"), Severity.CRITICAL, ""),
    ("Markdown", re.compile(r"\*\*|__|\[[^\]]+\]\([^)]+\)|^#{1,6}\s", re.MULTILINE), Severity.CRITICAL, ""),
    ("Curly-brace placeholder", re.compile(r"\{[A-Za-z0-9_]*\}"), Severity.CRITICAL, "Placeholder integrity"),
    ("URL or email", re.compile(r"https?://\S+|\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b"), Severity.CRITICAL, ""),
)

#: Characters the skill lists as stray unless `style/characters` approves them.
_CONDITIONAL_SYMBOLS = "@|^~"

#: Drafting leftovers. Case-insensitive; `xxx` only as a whole word so it does
#: not fire inside a real word of the language.
_DRAFT_NOTES = re.compile(r"\bTODO\b|\?\?\?|\bxxx\b|\[check\]", re.IGNORECASE)

_MOJIBAKE = re.compile(r"Ã[\x80-\xbf]|â€[\x99\x9c\x9d]|Â[\xa0-\xbf]")
_REPLACEMENT = "\ufffd"

#: Runs of this many consecutive words identical to the source verse.
_SOURCE_RUN = 4
#: A sentence this long repeating inside one cell is a copy-paste duplicate.
_DUPLICATE_SENTENCE_WORDS = 8


def run(corpus: Corpus, *, approved_characters: set[str] | None = None) -> FindingSet:
    out = FindingSet(SKILL)
    approved = approved_characters or set()
    translated = [v for v in corpus if v.has_target]
    out.log(f"cells with target text: {len(translated)}")

    for verse in translated:
        _stray_markup(verse, approved, out)
        _draft_notes(verse, out)
        _leftover_source(verse, out)
        _duplicate_sentence(verse, out)
        _placeholder_cell(verse, out)
        _spacing(verse, out)
        _encoding(verse, out)
    _cross_cell_duplicates(translated, out)
    return out


def _add(out: FindingSet, verse: Verse, **kwargs) -> None:
    out.add(
        Finding(
            skill=SKILL,
            refs=(verse.ref_label,),
            cell_ids=(verse.cell_id,),
            file_id=verse.file_id,
            verifier=_VERIFIER,
            confidence=Confidence.HIGH,
            **kwargs,
        )
    )


def _stray_markup(verse: Verse, approved: set[str], out: FindingSet) -> None:
    for check, pattern, severity, builtin in _STRAY_PATTERNS:
        match = pattern.search(verse.target)
        if not match:
            continue
        evidence = f"matched {match.group(0)!r}"
        if builtin:
            evidence += f"; overlaps Aquilla's {builtin} — cite that check, do not re-describe it"
        _add(
            out,
            verse,
            check=f"Stray markup — {check}",
            severity=severity,
            found=f"{check} in the target text: {match.group(0)!r}",
            evidence=evidence,
            proposed_fix="remove the markup; the text is published as plain text",
        )
    for symbol in _CONDITIONAL_SYMBOLS:
        if symbol in verse.target and symbol not in approved:
            _add(
                out,
                verse,
                check="Stray markup — unapproved symbol",
                severity=Severity.CRITICAL,
                found=f"{symbol!r} appears in the target text",
                evidence="not present in the verified style/characters baseline",
                proposed_fix=f"remove {symbol!r}, or have the proof-reader add it to style/characters",
            )


def _draft_notes(verse: Verse, out: FindingSet) -> None:
    match = _DRAFT_NOTES.search(verse.target)
    if match:
        _add(
            out,
            verse,
            check="Drafting note left in the text",
            severity=Severity.CRITICAL,
            found=f"{match.group(0)!r} in the target text",
            evidence="qa-text-integrity.md → 2: drafting notes are Critical",
            proposed_fix="resolve the note and remove the marker before publication",
        )


def _leftover_source(verse: Verse, out: FindingSet) -> None:
    if not verse.has_source:
        return
    source_words = tokenize(verse.source.lower())
    target_words = tokenize(verse.target.lower())
    if len(target_words) <= _SOURCE_RUN:
        return
    source_runs = set(ngrams(source_words, _SOURCE_RUN))
    if not source_runs:
        return
    shared = [run for run in ngrams(target_words, _SOURCE_RUN) if run in source_runs]
    if not shared:
        return
    # A cell that IS the source text is "untranslated", which is Aquilla's own
    # check. This one is about a run left inside an otherwise translated cell.
    if len(shared) >= max(1, len(target_words) - _SOURCE_RUN):
        return
    _add(
        out,
        verse,
        check="Leftover source text",
        severity=Severity.MAJOR,
        found=f"{len(shared)} run(s) of {_SOURCE_RUN}+ words identical to the source verse",
        evidence=f"first run: {' '.join(shared[0])!r}; overlaps Aquilla's Untranslated words",
        proposed_fix="translate the remaining source fragment",
    )


def _duplicate_sentence(verse: Verse, out: FindingSet) -> None:
    seen: set[str] = set()
    for sentence in sentences(verse.target):
        words = tokenize(sentence)
        if len(words) < _DUPLICATE_SENTENCE_WORDS:
            continue
        key = " ".join(w.lower() for w in words)
        if key in seen:
            _add(
                out,
                verse,
                check="Duplicated sentence within the cell",
                severity=Severity.MAJOR,
                found=f"a {len(words)}-word sentence appears twice in one cell",
                evidence=f"{sentence[:60]!r}",
                proposed_fix="delete the repeated sentence",
            )
            return
        seen.add(key)


def _placeholder_cell(verse: Verse, out: FindingSet) -> None:
    if not verse.has_source:
        return
    stripped = verse.target.strip()
    only_punctuation = stripped != "" and all(
        unicodedata.category(c).startswith("P") or c.isspace() for c in stripped
    )
    if len(stripped) == 1 or stripped.isdigit() or only_punctuation:
        _add(
            out,
            verse,
            check="Placeholder cell",
            severity=Severity.CRITICAL,
            found=f"the target cell holds only {stripped!r} while the source verse has text",
            evidence=f"source {len(verse.source)} chars, target {len(stripped)} chars",
            proposed_fix="translate the verse, or clear the placeholder so it reads as untranslated",
        )


def _spacing(verse: Verse, out: FindingSet) -> None:
    issues: list[str] = []
    if verse.target != verse.target.strip():
        issues.append("leading or trailing space")
    if "  " in verse.target:
        issues.append("double space")
    if issues:
        _add(
            out,
            verse,
            check="Spacing",
            severity=Severity.MINOR,
            found=", ".join(issues),
            evidence="overlaps Aquilla's Extra whitespace — reported once, here",
            proposed_fix="trim and collapse the spacing",
        )
    if any(c in verse.target for c in "\t\n\r"):
        out.add(
            Finding(
                skill=SKILL,
                check="Line break inside a cell",
                severity=Severity.QUERY,
                confidence=Confidence.MEDIUM,
                refs=(verse.ref_label,),
                cell_ids=(verse.cell_id,),
                file_id=verse.file_id,
                found="the cell contains a tab or line break",
                evidence="qa-text-integrity.md → 5: a Query unless the verse is poetry and the team uses breaks",
                proposed_fix="confirm the break is intended for poetry; otherwise remove it",
                verifier=_VERIFIER,
            )
        )


def _encoding(verse: Verse, out: FindingSet) -> None:
    if _REPLACEMENT in verse.target or _MOJIBAKE.search(verse.target):
        _add(
            out,
            verse,
            check="Corrupted characters",
            severity=Severity.CRITICAL,
            found="replacement character or mojibake in the target text",
            evidence="overlaps Aquilla's Corrupted characters",
            proposed_fix="re-enter the text from the source draft in UTF-8",
        )
    if not verse.is_nfc:
        _add(
            out,
            verse,
            check="Not NFC-normalized",
            severity=Severity.MINOR,
            found="the stored text is not NFC-normalized",
            evidence=f"NFC changes {sum(1 for a, b in zip(verse.target_raw, normalize(verse.target_raw)) if a != b)} character(s)",
            proposed_fix="normalize to NFC as one batch fix the post-editor approves",
        )


def _cross_cell_duplicates(verses: list[Verse], out: FindingSet) -> None:
    """A cell whose text appears in another, unrelated verse (Major).

    Same-chapter duplicates are qa-chapter-verse's "Duplicated text"; this is
    the cross-chapter case, which may legitimately be a parallel passage — so
    the finding says so and leaves the judgment with the mentor's parallel pass.
    """
    by_text: dict[str, Verse] = {}
    for verse in verses:
        key = verse.target.strip()
        if len(key) < 40:
            continue
        first = by_text.setdefault(key, verse)
        if first is verse or first.chapter == verse.chapter:
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Text repeated in an unrelated verse",
                severity=Severity.MAJOR,
                confidence=Confidence.HIGH,
                refs=(first.ref_label, verse.ref_label),
                cell_ids=(first.cell_id, verse.cell_id),
                file_id=verse.file_id,
                found="two cells in different chapters hold identical text",
                evidence=f"{len(key)} identical characters",
                proposed_fix="check both against their own source verses, unless this is a parallel passage",
                verifier=_VERIFIER,
            )
        )
