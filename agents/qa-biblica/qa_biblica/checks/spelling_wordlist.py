"""Pass 2 — `skills/qa-spelling-wordlist.md`. Spelling against the baseline.

There is no dictionary for these languages; `glossary/wordlist-approved` is the
dictionary. The pass never judges spelling from the model's own knowledge of the
language — the skill file forbids it, and there is no code path here that could:
every classification is a comparison against the verified lists, and anything
that is not a comparison comes out as a Query for the proof-reader.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from ..baseline import Baseline
from ..corpus import Corpus, Verse, tokenize
from ..findings import Confidence, Finding, FindingSet, Severity, Verifier

SKILL = "qa-spelling-wordlist"
_VERIFIER = Verifier.PROOF_READER

#: Edit distance that counts as a variant, by word length.
VARIANT_DISTANCE_SHORT = 1
VARIANT_DISTANCE_LONG = 2
LONG_WORD = 8


@dataclass
class NewWord:
    """A word for the proof-reader to approve or reject."""

    word: str
    count: int
    refs: tuple[str, ...]
    nearest_approved: str = ""
    decision: str = ""


@dataclass
class SpellingResult:
    findings: FindingSet
    #: The new-word list, sorted by count — the CSV the skill file asks for.
    new_words: list[NewWord] = field(default_factory=list)


def run(corpus: Corpus, baseline: Baseline) -> SpellingResult:
    out = FindingSet(SKILL)
    if not baseline.approved_words:
        out.skip(
            "all checks",
            "no verified glossary/wordlist-approved baseline — run qa-bootstrap-inventories "
            "first (qa-spelling-wordlist.md → Baseline).",
        )
        return SpellingResult(out)

    occurrences: dict[str, list[Verse]] = {}
    counts: Counter[str] = Counter()
    skipped_numeric = 0
    for verse in corpus:
        if not verse.has_target:
            continue
        for word in tokenize(verse.target, word_chars=_word_chars(baseline)):
            if is_numeric(word):
                # Numbers are qa-capitalization-numbers' business, and they are
                # checked there against the source verse. Running them through
                # the wordlist too would report every number in the book as an
                # unapproved "new word" — noise that buries the real ones.
                skipped_numeric += 1
                continue
            counts[word] += 1
            seen = occurrences.setdefault(word, [])
            # One ref per verse: a word used twice in a cell is one reference,
            # not two identical ones.
            if not seen or seen[-1].cell_id != verse.cell_id:
                seen.append(verse)

    out.log(
        f"tokens: {sum(counts.values())}; distinct words: {len(counts)}; "
        f"numeric tokens skipped (checked by qa-capitalization-numbers): {skipped_numeric}"
    )
    out.log(f"approved wordlist: {len(baseline.approved_words)} words")

    new_words: list[NewWord] = []
    classified = Counter()
    for word, count in counts.most_common():
        verses = occurrences[word][:5]
        kind = classify(word, baseline)
        classified[kind] += 1
        if kind == "approved":
            continue
        if kind == "incorrect":
            _finding(
                out, verses, word, count,
                check="Known-incorrect spelling",
                found=f"{word!r} is on glossary/wordlist-incorrect",
                evidence=f"{count} occurrence(s)",
                fix=f"write {baseline.incorrect_words[word]!r}"
                if baseline.incorrect_words.get(word)
                else "use the approved spelling",
            )
        elif kind == "joined-split":
            _finding(
                out, verses, word, count,
                check="Joined/split word",
                found=f"{word!r} occurs while its split or joined form is approved",
                evidence=f"{count} occurrence(s)",
                fix="write the approved form",
            )
        elif kind == "variant":
            nearest = nearest_approved(word, baseline.approved_words)
            _finding(
                out, verses, word, count,
                check="Spelling variant",
                found=f"{word!r} is not approved but is one edit from {nearest!r}",
                evidence=f"{count} occurrence(s); nearest approved word {nearest!r}",
                fix=f"likely {nearest!r} — the proof-reader decides; never bulk-replace",
            )
        else:
            new_words.append(
                NewWord(
                    word=word,
                    count=count,
                    refs=tuple(v.ref_label for v in verses),
                    nearest_approved=nearest_approved(word, baseline.approved_words),
                )
            )
            out.add(
                Finding(
                    skill=SKILL,
                    check="New word",
                    severity=Severity.QUERY,
                    confidence=Confidence.MEDIUM,
                    refs=tuple(v.ref_label for v in verses),
                    cell_ids=tuple(v.cell_id for v in verses),
                    file_id=verses[0].file_id if verses else "",
                    found=f"{word!r} is not in the approved wordlist ({count} occurrence(s))",
                    evidence="not approved, not known-incorrect, and not within variant distance",
                    proposed_fix="the proof-reader approves or rejects it; a single use is the likeliest typo",
                    verifier=_VERIFIER,
                )
            )
    out.log("classified: " + ", ".join(f"{k}={v}" for k, v in sorted(classified.items())))
    new_words.sort(key=lambda n: (-n.count, n.word))
    return SpellingResult(out, new_words)


def is_numeric(word: str) -> bool:
    """A token that is only digits and number punctuation is a number, not a word."""
    return any(c.isdigit() for c in word) and not any(c.isalpha() for c in word)


def _word_chars(baseline: Baseline) -> str:
    """Hyphen and apostrophe count as word characters when the baseline has them."""
    chars = "".join(c for c in "'’-" if c in baseline.characters)
    return chars or "'’-"


def _finding(out: FindingSet, verses, word, count, *, check, found, evidence, fix) -> None:
    out.add(
        Finding(
            skill=SKILL,
            check=check,
            severity=Severity.MAJOR,
            confidence=Confidence.HIGH,
            refs=tuple(v.ref_label for v in verses),
            cell_ids=tuple(v.cell_id for v in verses),
            file_id=verses[0].file_id if verses else "",
            found=found,
            evidence=evidence,
            proposed_fix=fix,
            verifier=_VERIFIER,
        )
    )


def classify(word: str, baseline: Baseline) -> str:
    """One of `approved` | `incorrect` | `variant` | `joined-split` | `new`."""
    if word in baseline.incorrect_words:
        return "incorrect"
    approved = baseline.approved_casefolded()
    if word.casefold() in approved:
        return "approved"
    if strip_affixes(word, baseline).casefold() in approved:
        return "approved"
    if _joined_or_split(word.casefold(), approved):
        return "joined-split"
    if nearest_approved(word, baseline.approved_words):
        return "variant"
    return "new"


def strip_affixes(word: str, baseline: Baseline) -> str:
    """Remove one verified prefix and one verified suffix, longest first.

    Only affixes the mentor verified through `style/grammar-profile` are used —
    never an affix the model guessed (qa-grammar-profile.md → Do not).
    """
    stem = word
    for prefix in sorted(baseline.prefixes, key=len, reverse=True):
        if prefix and stem.startswith(prefix) and len(stem) > len(prefix) + 1:
            stem = stem[len(prefix) :]
            break
    for suffix in sorted(baseline.suffixes, key=len, reverse=True):
        if suffix and stem.endswith(suffix) and len(stem) > len(suffix) + 1:
            stem = stem[: -len(suffix)]
            break
    return stem


def _joined_or_split(word: str, approved: frozenset[str] | set[str]) -> bool:
    """`XY` where `X` and `Y` are both approved — the joined half of the check.

    The split half (`X Y` where `XY` is approved) is detected the same way from
    the other direction: a token that is an approved word's prefix, with the
    remainder also approved, is reported on the joined token.
    """
    for split in range(2, len(word) - 1):
        if word[:split] in approved and word[split:] in approved:
            return True
    return False


def edit_distance(a: str, b: str, *, ceiling: int) -> int:
    """Levenshtein distance, abandoned once it exceeds `ceiling`."""
    if abs(len(a) - len(b)) > ceiling:
        return ceiling + 1
    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, start=1):
        current = [i]
        for j, char_b in enumerate(b, start=1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (char_a != char_b),
                )
            )
        if min(current) > ceiling:
            return ceiling + 1
        previous = current
    return previous[-1]


def nearest_approved(word: str, approved) -> str:
    """The approved word within variant distance, or '' if there is none.

    Compared casefolded, for the reason in `Baseline.approved_casefolded`, but
    the candidate is returned in its own case so the proposed fix reads right.
    """
    ceiling = VARIANT_DISTANCE_LONG if len(word) >= LONG_WORD else VARIANT_DISTANCE_SHORT
    folded = word.casefold()
    best, best_distance = "", ceiling + 1
    for candidate in approved:
        distance = edit_distance(folded, candidate.casefold(), ceiling=ceiling)
        if distance < best_distance and distance > 0:
            best, best_distance = candidate, distance
            if distance == 1:
                break
    return best if best_distance <= ceiling else ""
