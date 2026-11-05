"""Pass 1 — `skills/qa-chapter-verse.md`. Chapter and verse completeness.

Every finding here is code-produced, so they all carry Confidence High except
the bridge mismatch, which the skill file itself calls a Query ("it may be
deliberate").
"""

from __future__ import annotations

import re
from statistics import median

from ..corpus import Corpus, Verse
from ..findings import Confidence, Finding, FindingSet, Severity, Verifier

SKILL = "qa-chapter-verse"
_VERIFIER = Verifier.POST_EDITOR

#: qa-chapter-verse.md → 3. Reported against the *project's source text*: a
#: mismatch is only a finding when source and target disagree about the verse.
TEXTUAL_VARIANTS: frozenset[str] = frozenset(
    {
        "MAT 17:21", "MAT 18:11", "MAT 23:14", "MRK 7:16", "MRK 9:44", "MRK 9:46",
        "MRK 11:26", "MRK 15:28", "LUK 17:36", "LUK 23:17", "JHN 5:4", "ACT 8:37",
        "ACT 15:34", "ACT 24:7", "ACT 28:29", "ROM 16:24",
    }
)

#: The two long variant passages, as (book, chapter, first, last).
VARIANT_PASSAGES: tuple[tuple[str, int, int, int], ...] = (
    ("MRK", 16, 9, 20),
    ("JHN", 7, 53, 53),
    ("JHN", 8, 1, 11),
)

#: A cell that opens with a bare verse number: `16 For God…`.
_LEADING_NUMBER = re.compile(r"^\s*\(?\[?(\d{1,3})\b")
#: Merged-verse threshold from the skill file.
_MERGE_RATIO = 1.8
#: "very short" for the split/merge neighbour test, in characters.
_SHORT = 12


def run(corpus: Corpus) -> FindingSet:
    out = FindingSet(SKILL)
    out.log(f"cells read: {len(corpus)}")

    _duplicate_refs(corpus, out)
    for book in corpus.books():
        verses = corpus.by_book(book)
        _missing_and_extra(book, verses, out)
        _merged_and_split(book, verses, out)
        _duplicated_text(book, verses, out)
        _leading_verse_number(verses, out)
        _textual_variants(verses, out)
        _chapter_count(book, verses, out)
    return out


# ---------------------------------------------------------------------------


def _bridged_verses(verses: list[Verse]) -> set[tuple[str, int, int]]:
    """Verses a target bridge already covers, so they are not 'missing'."""
    covered: set[tuple[str, int, int]] = set()
    for verse in verses:
        if verse.ref and verse.ref.is_bridge and verse.has_target:
            for number in verse.ref.verses:
                covered.add((verse.ref.book, verse.ref.chapter, number))
    return covered


def _missing_and_extra(book: str, verses: list[Verse], out: FindingSet) -> None:
    covered = _bridged_verses(verses)
    missing = 0
    for verse in verses:
        if not verse.ref:
            continue
        key = (verse.ref.book, verse.ref.chapter, verse.ref.verse)
        if verse.has_source and not verse.has_target and key not in covered:
            missing += 1
            out.add(
                Finding(
                    skill=SKILL,
                    check="Missing verse",
                    severity=Severity.CRITICAL,
                    confidence=Confidence.HIGH,
                    refs=(verse.ref_label,),
                    cell_ids=(verse.cell_id,),
                    file_id=verse.file_id,
                    found="the source verse has text; the target cell is empty",
                    evidence=f"source {len(verse.source)} chars, target 0 chars",
                    proposed_fix="translate the verse; the source text is quoted on the cell",
                    verifier=_VERIFIER,
                )
            )
        elif verse.has_target and not verse.has_source:
            out.add(
                Finding(
                    skill=SKILL,
                    check="Extra verse",
                    severity=Severity.CRITICAL,
                    confidence=Confidence.HIGH,
                    refs=(verse.ref_label,),
                    cell_ids=(verse.cell_id,),
                    file_id=verse.file_id,
                    found="a target cell holds text at a reference the source does not have",
                    evidence="no source row for this reference",
                    proposed_fix="confirm the reference against the source text and remove or re-anchor",
                    verifier=_VERIFIER,
                )
            )
    out.log(f"{book}: {missing} missing verse(s) over {len(verses)} cells")


def _duplicate_refs(corpus: Corpus, out: FindingSet) -> None:
    seen: dict[str, Verse] = {}
    for verse in corpus:
        if not verse.ref:
            continue
        label = verse.ref_label
        first = seen.get(label)
        if first is None:
            seen[label] = verse
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Duplicate verse",
                severity=Severity.CRITICAL,
                confidence=Confidence.HIGH,
                refs=(label,),
                cell_ids=(verse.cell_id,),
                file_id=verse.file_id,
                found="the same reference appears in two cells",
                evidence=f"cells {first.cell_id} and {verse.cell_id}",
                proposed_fix="keep one cell for the reference and remove or re-anchor the other",
                verifier=_VERIFIER,
            )
        )


def _ratio_median(verses: list[Verse]) -> float:
    ratios = [
        len(v.target) / len(v.source)
        for v in verses
        if v.has_source and v.has_target and len(v.source) > 0
    ]
    return median(ratios) if ratios else 1.0


def _merged_and_split(book: str, verses: list[Verse], out: FindingSet) -> None:
    baseline = _ratio_median(verses)
    out.log(f"{book}: median target/source length ratio {baseline:.2f}")
    for position, verse in enumerate(verses):
        if not (verse.has_source and verse.has_target):
            continue
        ratio = len(verse.target) / max(len(verse.source), 1)
        nxt = verses[position + 1] if position + 1 < len(verses) else None
        prev = verses[position - 1] if position > 0 else None

        if ratio > baseline * _MERGE_RATIO and nxt is not None and len(nxt.target.strip()) <= _SHORT:
            out.add(
                Finding(
                    skill=SKILL,
                    check="Merged verses",
                    severity=Severity.CRITICAL,
                    confidence=Confidence.HIGH,
                    refs=(verse.ref_label, nxt.ref_label),
                    cell_ids=(verse.cell_id, nxt.cell_id),
                    file_id=verse.file_id,
                    found=f"this cell is {ratio / baseline:.1f}× the book's median length while the next is near-empty",
                    evidence=f"ratio {ratio:.2f} vs median {baseline:.2f}; next cell {len(nxt.target.strip())} chars",
                    proposed_fix="split the text back into its two verses",
                    verifier=_VERIFIER,
                )
            )
        if (
            len(verse.target.strip()) <= _SHORT
            and prev is not None
            and prev.has_source
            and len(prev.target) / max(len(prev.source), 1) > baseline * _MERGE_RATIO
        ):
            out.add(
                Finding(
                    skill=SKILL,
                    check="Split verse",
                    severity=Severity.CRITICAL,
                    confidence=Confidence.HIGH,
                    refs=(prev.ref_label, verse.ref_label),
                    cell_ids=(prev.cell_id, verse.cell_id),
                    file_id=verse.file_id,
                    found="this cell is near-empty while the one before it is far over the median length",
                    evidence=f"{len(verse.target.strip())} chars after a {len(prev.target)}-char cell",
                    proposed_fix="move this verse's text out of the previous cell",
                    verifier=_VERIFIER,
                )
            )


def _duplicated_text(book: str, verses: list[Verse], out: FindingSet) -> None:
    by_chapter: dict[int, list[Verse]] = {}
    for verse in verses:
        if verse.has_target and verse.ref:
            by_chapter.setdefault(verse.ref.chapter, []).append(verse)
    for chapter, chapter_verses in by_chapter.items():
        seen: dict[str, Verse] = {}
        for verse in chapter_verses:
            key = verse.target.strip()
            if len(key) < 20:  # a short formula repeating is not evidence
                continue
            first = seen.get(key)
            if first is None:
                seen[key] = verse
                continue
            out.add(
                Finding(
                    skill=SKILL,
                    check="Duplicated text",
                    severity=Severity.MAJOR,
                    confidence=Confidence.HIGH,
                    refs=(first.ref_label, verse.ref_label),
                    cell_ids=(first.cell_id, verse.cell_id),
                    file_id=verse.file_id,
                    found="two cells in the same chapter hold identical text",
                    evidence=f"{len(key)} identical characters in {book} {chapter}",
                    proposed_fix="translate the second verse from its own source text",
                    verifier=_VERIFIER,
                )
            )


def _leading_verse_number(verses: list[Verse], out: FindingSet) -> None:
    for verse in verses:
        if not verse.has_target or not verse.ref:
            continue
        match = _LEADING_NUMBER.match(verse.target)
        if not match:
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Verse number typed in the text",
                severity=Severity.MAJOR,
                confidence=Confidence.HIGH,
                refs=(verse.ref_label,),
                cell_ids=(verse.cell_id,),
                file_id=verse.file_id,
                found=f"the cell starts with the number {match.group(1)}",
                evidence=f"text begins {verse.target[:24]!r}",
                proposed_fix="remove the verse number; Aquilla holds the reference",
                verifier=_VERIFIER,
            )
        )


def _textual_variants(verses: list[Verse], out: FindingSet) -> None:
    passage_refs = {
        f"{book} {chapter}:{number}"
        for book, chapter, first, last in VARIANT_PASSAGES
        for number in range(first, last + 1)
    }
    for verse in verses:
        if not verse.ref:
            continue
        label = str(verse.ref)
        if label not in TEXTUAL_VARIANTS and label not in passage_refs:
            continue
        if verse.has_source == verse.has_target:
            continue
        direction = (
            "the source includes this variant verse but the target omits it"
            if verse.has_source
            else "the target includes this variant verse but the source omits it"
        )
        out.add(
            Finding(
                skill=SKILL,
                check="Textual-variant mismatch with the source",
                severity=Severity.MAJOR,
                confidence=Confidence.HIGH,
                refs=(label,),
                cell_ids=(verse.cell_id,),
                file_id=verse.file_id,
                found=direction,
                evidence="qa-chapter-verse.md → 3: follow the project's source text",
                proposed_fix="match the source text — include the verse, or omit it as the source does",
                verifier=_VERIFIER,
            )
        )


def _chapter_count(book: str, verses: list[Verse], out: FindingSet) -> None:
    source_chapters = {v.ref.chapter for v in verses if v.ref and v.has_source}
    target_chapters = {v.ref.chapter for v in verses if v.ref and v.has_target}
    extra = sorted(target_chapters - source_chapters)
    absent = sorted(source_chapters - target_chapters)
    if not extra and not absent:
        out.log(f"{book}: {len(source_chapters)} chapters, matching the source")
        return
    out.add(
        Finding(
            skill=SKILL,
            check="Chapter count differs from the source",
            severity=Severity.CRITICAL,
            confidence=Confidence.HIGH,
            refs=(),
            file_id=verses[0].file_id if verses else "",
            found=f"{book}: target has {len(target_chapters)} chapters, source has {len(source_chapters)}",
            evidence=f"no target text in chapter(s) {absent or '—'}; target-only chapter(s) {extra or '—'}",
            proposed_fix="check the import against the source text for the whole book",
            verifier=_VERIFIER,
        )
    )


#: Reported in the run's "Not checked" section rather than as findings.
#:
#: qa-chapter-verse.md asks for a bridge mismatch — "the target joins verses the
#: source keeps separate, or splits a source bridge". Aquilla's cell model gives
#: a cell ONE canonicalRef shared by its source and target rows, so a target that
#: bridges while the source does not is not observable over the Agent API: both
#: sides read back the same reference. The genuinely visible half of the symptom
#: (one long cell beside a near-empty one) is already "Merged verses" above.
#:
#: Filed rather than faked. Reporting every bridge as a Query would bury the
#: mentor in noise about deliberate versification.
NOT_CHECKED: tuple[str, ...] = (
    "Bridge mismatch: source and target share one reference per cell over the Agent API, "
    "so a target-only bridge is not observable. The length-based half of the symptom is "
    "covered by 'Merged verses'.",
)
