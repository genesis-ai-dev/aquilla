"""Pass 0 — `skills/qa-bootstrap-inventories.md`. Build the baseline.

Six CSVs, each in the skill file's own column layout, each built from
API-read cells of the **approved books only** — the skill file's "Do not" is
explicit about that, so `build` takes the corpus already filtered to the
approved list and never widens it.

Every list obeys the shared rules in that file:

* each row carries item, count, share, 3 sample refs, `Outlier?` (with the
  reason), `Suggested`, and an empty `Decision` column for the team;
* `Suggested = Approve` only when the item is the dominant form (≥95% of its
  group) and not an outlier; `Reject` when it is clearly an error; `Decide` for
  everything else — which is why nothing here can approve anything;
* rows sort with outliers and `Decide` first, then by count.
"""

from __future__ import annotations

import csv
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .checks.characters_punctuation import INVISIBLE, LOOKALIKES, _script_of
from .checks.spelling_wordlist import edit_distance, is_numeric
from .corpus import Corpus, Verse, tokenize
from .findings import Verifier

#: The shared column layout from qa-bootstrap-inventories.md → Rules for every list.
COMMON_COLUMNS: tuple[str, ...] = (
    "item",
    "count",
    "share",
    "sample 1",
    "sample 2",
    "sample 3",
    "Outlier?",
    "Suggested",
    "Decision",
)

#: "dominant form" threshold. Below it, the majority is NOT correct — it is a
#: Decide row. The skill file says so twice.
DOMINANT_SHARE = 0.95
#: Fewer than this many uses is an outlier.
RARE_USES = 3
#: A minority spacing pattern under this share is an outlier.
MINORITY_SPACING = 0.05
#: Rendering coverage at or above this approves a key term.
KEYTERM_COVERAGE = 0.90

SUGGEST_APPROVE = "Approve"
SUGGEST_REJECT = "Reject"
SUGGEST_DECIDE = "Decide"


@dataclass
class Row:
    item: str
    count: int
    share: float
    samples: tuple[str, ...] = ()
    outlier: str = ""
    suggested: str = SUGGEST_DECIDE
    #: Extra leading columns for the lists whose layout differs (keyterms, names).
    extra: dict[str, str] = field(default_factory=dict)

    @property
    def sort_key(self) -> tuple[int, int]:
        """Outliers and Decide rows first, then by count (descending)."""
        priority = 0 if (self.outlier or self.suggested != SUGGEST_APPROVE) else 1
        return (priority, -self.count)

    def as_dict(self, columns: tuple[str, ...]) -> dict[str, str]:
        samples = list(self.samples[:3]) + [""] * max(0, 3 - len(self.samples))
        base = {
            "item": self.item,
            "count": str(self.count),
            "share": f"{self.share * 100:.1f}%",
            "sample 1": samples[0],
            "sample 2": samples[1],
            "sample 3": samples[2],
            "Outlier?": self.outlier,
            "Suggested": self.suggested,
            "Decision": "",
            **self.extra,
        }
        return {column: base.get(column, "") for column in columns}


@dataclass
class Inventory:
    name: str
    filename: str
    columns: tuple[str, ...]
    verified_by: Verifier
    rows: list[Row] = field(default_factory=list)

    def sorted_rows(self) -> list[Row]:
        return sorted(self.rows, key=lambda r: r.sort_key)

    @property
    def outliers(self) -> int:
        return sum(1 for row in self.rows if row.outlier)

    @property
    def to_decide(self) -> list[Row]:
        return [r for r in self.sorted_rows() if r.suggested == SUGGEST_DECIDE]

    def write_csv(self, directory: str | Path) -> Path:
        path = Path(directory) / self.filename
        with open(path, "w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(self.columns))
            writer.writeheader()
            for row in self.sorted_rows():
                writer.writerow(row.as_dict(self.columns))
        return path

    def chat_summary(self) -> str:
        """Totals, outlier count, and the top 10 items to decide."""
        top = self.to_decide[:10]
        listed = ", ".join(f"{r.item} (×{r.count})" for r in top) or "none"
        return (
            f"{self.filename}: {len(self.rows)} items, {self.outliers} outlier(s), "
            f"{len(self.to_decide)} to decide. Top to decide: {listed}. "
            f"Verified by {self.verified_by.value}."
        )


@dataclass
class BootstrapResult:
    inventories: list[Inventory]
    code_log: list[str] = field(default_factory=list)

    def write_all(self, directory: str | Path) -> list[Path]:
        Path(directory).mkdir(parents=True, exist_ok=True)
        return [inventory.write_csv(directory) for inventory in self.inventories]

    def summaries(self) -> list[str]:
        return [inventory.chat_summary() for inventory in self.inventories]


def build(
    corpus: Corpus,
    *,
    approved_books: tuple[str, ...],
    key_terms: dict[str, str] | None = None,
) -> BootstrapResult:
    """Mine the approved books for the six verification lists.

    `key_terms` maps a source term to its list ID, read from the operator's
    Biblica Key terms list file — never from the Knowledge base and never from
    the model's own knowledge.
    """
    off_list = sorted({v.book for v in corpus if v.book and v.book not in approved_books})
    if off_list:
        raise ValueError(
            "the bootstrap may only read approved books "
            f"(qa-bootstrap-inventories.md → Do not); corpus includes {', '.join(off_list)}"
        )

    translated = [v for v in corpus if v.has_target]
    log = [
        f"approved books: {', '.join(approved_books)}",
        f"cells with target text: {len(translated)} of {len(corpus)}",
    ]
    inventories = [
        _characters(translated, log),
        _punctuation(translated, log),
        _conventions(translated, log),
        _wordlist(translated, log),
        _keyterms(translated, key_terms or {}, log),
        _names(translated, log),
    ]
    return BootstrapResult(inventories, log)


# ---------------------------------------------------------------------------
# 1. characters.csv
# ---------------------------------------------------------------------------


def _characters(verses: list[Verse], log: list[str]) -> Inventory:
    columns = ("item", "code point", "Unicode name", "script", "count", "share",
               "sample 1", "sample 2", "sample 3", "Outlier?", "Suggested", "Decision")
    counts: Counter[str] = Counter()
    samples: dict[str, list[str]] = defaultdict(list)
    for verse in verses:
        for char in verse.target:
            if char.isspace():
                continue
            counts[char] += 1
            if len(samples[char]) < 3 and verse.ref_label not in samples[char]:
                samples[char].append(verse.ref_label)

    total = sum(counts.values()) or 1
    main_script = Counter(
        _script_of(c) for c in counts if c.isalpha() and _script_of(c)
    ).most_common(1)
    dominant_script = main_script[0][0] if main_script else ""

    inventory = Inventory("Characters", "characters.csv", columns, Verifier.PROOF_READER)
    for char, count in counts.items():
        reasons: list[str] = []
        script = _script_of(char)
        category = unicodedata.category(char)
        if count < RARE_USES:
            reasons.append(f"fewer than {RARE_USES} uses")
        if char in INVISIBLE or category in {"Cc", "Cf"}:
            reasons.append("invisible or control character")
        if char.isalpha() and script and dominant_script and script != dominant_script:
            reasons.append(f"script {script}, not the main script {dominant_script}")
        twin = LOOKALIKES.get(char)
        if twin and twin in counts:
            reasons.append(f"look-alike of {twin!r}, both in use")
        if unicodedata.normalize("NFC", char) != char:
            reasons.append("changes under NFC normalization")

        suggested = SUGGEST_DECIDE
        if "invisible or control character" in reasons:
            suggested = SUGGEST_REJECT
        elif not reasons and count / total >= (1 / max(len(counts), 1)) * DOMINANT_SHARE:
            suggested = SUGGEST_APPROVE
        elif not reasons:
            suggested = SUGGEST_APPROVE
        inventory.rows.append(
            Row(
                item=char,
                count=count,
                share=count / total,
                samples=tuple(samples[char]),
                outlier="; ".join(reasons),
                suggested=suggested,
                extra={
                    "code point": f"U+{ord(char):04X}",
                    "Unicode name": unicodedata.name(char, "unnamed"),
                    "script": script,
                },
            )
        )
    log.append(
        f"characters.csv: {len(inventory.rows)} distinct characters, "
        f"{inventory.outliers} outlier(s), main script {dominant_script or 'undetermined'}"
    )
    return inventory


# ---------------------------------------------------------------------------
# 2. punctuation.csv
# ---------------------------------------------------------------------------


def _punctuation(verses: list[Verse], log: list[str]) -> Inventory:
    from .checks.characters_punctuation import _spacing_pattern

    columns = ("item", "code point", "count", "share", "spacing pattern", "pattern share",
               "sample 1", "sample 2", "sample 3", "Outlier?", "Suggested", "Decision")
    patterns: dict[str, Counter[str]] = defaultdict(Counter)
    samples: dict[str, list[str]] = defaultdict(list)
    for verse in verses:
        for position, char in enumerate(verse.target):
            if not unicodedata.category(char).startswith("P"):
                continue
            patterns[char][_spacing_pattern(verse.target, position)] += 1
            if len(samples[char]) < 3 and verse.ref_label not in samples[char]:
                samples[char].append(verse.ref_label)

    total = sum(sum(c.values()) for c in patterns.values()) or 1
    inventory = Inventory("Punctuation and spacing", "punctuation.csv", columns, Verifier.PROOF_READER)
    for mark, pattern_counts in patterns.items():
        count = sum(pattern_counts.values())
        dominant, dominant_count = pattern_counts.most_common(1)[0]
        dominant_share = dominant_count / count
        reasons: list[str] = []
        minority = [p for p, n in pattern_counts.items() if n / count < MINORITY_SPACING]
        if minority:
            reasons.append(f"minority spacing pattern(s) {', '.join(minority)} under 5%")
        twin = LOOKALIKES.get(mark)
        if twin and twin in patterns:
            reasons.append(f"two code points for one function ({mark!r} and {twin!r})")
        inventory.rows.append(
            Row(
                item=mark,
                count=count,
                share=count / total,
                samples=tuple(samples[mark]),
                outlier="; ".join(reasons),
                suggested=SUGGEST_APPROVE
                if dominant_share >= DOMINANT_SHARE and not reasons
                else SUGGEST_DECIDE,
                extra={
                    "code point": f"U+{ord(mark):04X}",
                    "spacing pattern": dominant,
                    "pattern share": f"{dominant_share * 100:.1f}%",
                },
            )
        )
    log.append(f"punctuation.csv: {len(inventory.rows)} marks, {inventory.outliers} outlier(s)")
    return inventory


# ---------------------------------------------------------------------------
# 3. conventions.csv
# ---------------------------------------------------------------------------


def _conventions(verses: list[Verse], log: list[str]) -> Inventory:
    from .checks.capitalization_numbers import BANDS, fold_digits
    import re

    columns = ("item", "majority form", "minority forms", "count", "share",
               "sample 1", "sample 2", "sample 3", "Outlier?", "Suggested", "Decision")
    inventory = Inventory("Conventions", "conventions.csv", columns, Verifier.MENTOR)

    # Capitalization of recurring words in mid-sentence.
    forms: dict[str, Counter[str]] = defaultdict(Counter)
    samples: dict[str, list[str]] = defaultdict(list)
    for verse in verses:
        words = tokenize(verse.target)
        for position, word in enumerate(words):
            if position == 0 or not word[:1].isalpha():
                continue
            forms[word.lower()][word] += 1
            if len(samples[word.lower()]) < 3:
                samples[word.lower()].append(verse.ref_label)
    for lower, counter in forms.items():
        if len(counter) < 2:
            continue
        (majority, majority_count), *rest = counter.most_common()
        count = sum(counter.values())
        share = majority_count / count
        inventory.rows.append(
            Row(
                item=lower,
                count=count,
                share=share,
                samples=tuple(samples[lower]),
                outlier="" if share >= DOMINANT_SHARE else f"majority form only {share * 100:.0f}%",
                suggested=SUGGEST_APPROVE if share >= DOMINANT_SHARE else SUGGEST_DECIDE,
                extra={
                    "majority form": majority,
                    "minority forms": ", ".join(f"{f} ×{n}" for f, n in rest),
                },
            )
        )

    # Numbers: digits vs words, by size band.
    digit_bands: Counter[str] = Counter()
    for verse in verses:
        for raw in re.findall(r"\d+", fold_digits(verse.target)):
            for name, low, high in BANDS:
                if low <= int(raw) <= high:
                    digit_bands[name] += 1
                    break
    for name, _, _ in BANDS:
        count = digit_bands.get(name, 0)
        inventory.rows.append(
            Row(
                item=f"numbers {name}",
                count=count,
                share=1.0 if count else 0.0,
                outlier="" if count else "no digit numerals in this band in the approved books",
                suggested=SUGGEST_DECIDE,
                extra={
                    "majority form": "digits" if count else "words (no digits seen)",
                    "minority forms": "",
                },
            )
        )
    log.append(
        f"conventions.csv: {len(inventory.rows)} conventions "
        f"({len(inventory.rows) - len(BANDS)} capitalization, {len(BANDS)} number bands)"
    )
    return inventory


# ---------------------------------------------------------------------------
# 4. wordlist.csv
# ---------------------------------------------------------------------------


def _wordlist(verses: list[Verse], log: list[str]) -> Inventory:
    columns = COMMON_COLUMNS
    counts: Counter[str] = Counter()
    samples: dict[str, list[str]] = defaultdict(list)
    for verse in verses:
        for word in tokenize(verse.target):
            if is_numeric(word):
                continue  # numbers live in conventions.csv, not the wordlist
            counts[word] += 1
            if len(samples[word]) < 3 and verse.ref_label not in samples[word]:
                samples[word].append(verse.ref_label)

    total = sum(counts.values()) or 1
    frequent = {w: n for w, n in counts.items() if n >= RARE_USES}
    inventory = Inventory("Wordlist", "wordlist.csv", columns, Verifier.PROOF_READER)
    for word, count in counts.items():
        reasons: list[str] = []
        ceiling = 2 if len(word) >= 8 else 1
        for candidate, candidate_count in frequent.items():
            if candidate == word or candidate_count < count * 10:
                continue
            if edit_distance(word, candidate, ceiling=ceiling) <= ceiling:
                reasons.append(f"variant pair: {ceiling} edit(s) from {candidate!r} (×{candidate_count})")
                break
        joined = _joined_split_partner(word, counts)
        if joined:
            reasons.append(f"joined/split: {joined!r} also occurs")
        if count == 1 and any(r.startswith("variant pair") for r in reasons):
            reasons.append("single use close to a frequent word")
        inventory.rows.append(
            Row(
                item=word,
                count=count,
                share=count / total,
                samples=tuple(samples[word]),
                outlier="; ".join(reasons),
                suggested=SUGGEST_APPROVE if count >= RARE_USES and not reasons else SUGGEST_DECIDE,
            )
        )
    log.append(
        f"wordlist.csv: {len(inventory.rows)} distinct words over {total} tokens, "
        f"{inventory.outliers} outlier(s)"
    )
    return inventory


def _joined_split_partner(word: str, counts: Counter[str]) -> str:
    """`XY` when `X` and `Y` both occur, or vice versa."""
    for split in range(2, len(word) - 1):
        left, right = word[:split], word[split:]
        if counts.get(left) and counts.get(right):
            return f"{left} {right}"
    return ""


# ---------------------------------------------------------------------------
# 5. keyterms.csv
# ---------------------------------------------------------------------------


def _keyterms(verses: list[Verse], key_terms: dict[str, str], log: list[str]) -> Inventory:
    """Candidate renderings, ranked by Dice co-occurrence.

    Columns follow Aquilla's CSV import order — `source term, rendering, status,
    notes` — with the list's ID kept in the notes so a concept matches across
    projects, then the shared verification columns.
    """
    columns = ("source term", "rendering", "status", "notes", "count", "share",
               "sample 1", "sample 2", "sample 3", "Outlier?", "Suggested", "Decision")
    inventory = Inventory("Key terms", "keyterms.csv", columns, Verifier.MENTOR)
    if not key_terms:
        log.append("keyterms.csv: no Biblica Key terms list supplied — produced empty, not guessed")
        return inventory

    for source_term, list_id in key_terms.items():
        term_verses = [v for v in verses if source_term.lower() in v.source.lower()]
        other_verses = [v for v in verses if v not in term_verses]
        if not term_verses:
            inventory.rows.append(
                Row(
                    item=source_term,
                    count=0,
                    share=0.0,
                    outlier="the source term does not occur in the approved books",
                    suggested=SUGGEST_DECIDE,
                    extra={"source term": source_term, "rendering": "", "status": "",
                           "notes": f"list ID {list_id}"},
                )
            )
            continue
        scored = _dice_candidates(term_verses, other_verses)
        for rendering, in_term, coverage in scored[:3]:
            inventory.rows.append(
                Row(
                    item=f"{source_term} → {rendering}",
                    count=in_term,
                    share=coverage,
                    samples=tuple(v.ref_label for v in term_verses[:3]),
                    outlier="" if coverage >= KEYTERM_COVERAGE else f"covers only {coverage * 100:.0f}% of the term's verses",
                    suggested=SUGGEST_APPROVE if coverage >= KEYTERM_COVERAGE else SUGGEST_DECIDE,
                    extra={
                        "source term": source_term,
                        "rendering": rendering,
                        "status": "",
                        "notes": f"list ID {list_id}; coverage {coverage * 100:.0f}% of {len(term_verses)} verses",
                    },
                )
            )
    log.append(
        f"keyterms.csv: {len(key_terms)} concepts from the Key terms list, "
        f"{len(inventory.rows)} candidate rendering row(s)"
    )
    return inventory


def _dice_candidates(
    term_verses: list[Verse], other_verses: list[Verse]
) -> list[tuple[str, int, float]]:
    """Rank target words by Dice co-occurrence with the term's verses."""
    in_term: Counter[str] = Counter()
    for verse in term_verses:
        in_term.update(set(tokenize(verse.target)))
    elsewhere: Counter[str] = Counter()
    for verse in other_verses:
        elsewhere.update(set(tokenize(verse.target)))

    scored: list[tuple[float, str, int, float]] = []
    for word, count in in_term.items():
        if len(word) < 2:
            continue
        dice = 2 * count / (len(term_verses) + count + elsewhere.get(word, 0))
        scored.append((dice, word, count, count / len(term_verses)))
    scored.sort(reverse=True)
    return [(word, count, coverage) for _, word, count, coverage in scored]


# ---------------------------------------------------------------------------
# 6. names.csv
# ---------------------------------------------------------------------------


def _names(verses: list[Verse], log: list[str]) -> Inventory:
    """Target words aligned with source-text names, clustered by spelling.

    "Names in the source text" means capitalized source words here — the skill
    file's own first definition. No name list of the model's own is used.
    """
    columns = ("item", "spellings", "count", "share", "sample 1", "sample 2", "sample 3",
               "Outlier?", "Suggested", "Decision")
    source_names: Counter[str] = Counter()
    for verse in verses:
        for position, word in enumerate(tokenize(verse.source)):
            if position > 0 and word[:1].isupper() and len(word) > 2:
                source_names[word] += 1

    candidates: dict[str, Counter[str]] = defaultdict(Counter)
    samples: dict[str, list[str]] = defaultdict(list)
    for verse in verses:
        present = [n for n in source_names if n.lower() in verse.source.lower()]
        if not present:
            continue
        for word in tokenize(verse.target):
            if len(word) < 3:
                continue
            for name in present:
                if word[:1].lower() == name[:1].lower() and edit_distance(
                    word.lower(), name.lower(), ceiling=2
                ) <= 2:
                    candidates[name][word] += 1
                    if len(samples[name]) < 3:
                        samples[name].append(verse.ref_label)

    total = sum(sum(c.values()) for c in candidates.values()) or 1
    inventory = Inventory("Proper names", "names.csv", columns, Verifier.MENTOR)
    for name, spellings in candidates.items():
        count = sum(spellings.values())
        (dominant, dominant_count), *rest = spellings.most_common()
        inventory.rows.append(
            Row(
                item=name,
                count=count,
                share=count / total,
                samples=tuple(samples[name]),
                outlier=f"{len(spellings)} spellings in use" if len(spellings) > 1 else "",
                suggested=SUGGEST_APPROVE if len(spellings) == 1 else SUGGEST_DECIDE,
                extra={
                    "spellings": "; ".join(f"{f} ×{n}" for f, n in spellings.most_common()),
                },
            )
        )
    log.append(
        f"names.csv: {len(source_names)} source-text name candidates, "
        f"{len(inventory.rows)} clustered target name(s), {inventory.outliers} with variant spellings"
    )
    return inventory


# ---------------------------------------------------------------------------
# After the team verifies
# ---------------------------------------------------------------------------


def read_key_terms(path: str | Path) -> dict[str, str]:
    """Read the operator's Biblica Key terms list: `source term,list id` CSV.

    An input file, not an API read and not a Knowledge-base read: the issue's
    design decision puts the four Biblica inputs on disk.
    """
    terms: dict[str, str] = {}
    with open(path, encoding="utf-8-sig", newline="") as handle:
        for row in csv.reader(handle):
            if not row or not row[0].strip() or row[0].strip().startswith("#"):
                continue
            term = row[0].strip()
            if term.lower() in {"source term", "term"}:
                continue
            terms[term] = row[1].strip() if len(row) > 1 else ""
    return terms


def read_decisions(path: str | Path) -> list[Row]:
    """Read a verification CSV back with the team's `Decision` column filled."""
    rows: list[Row] = []
    with open(path, encoding="utf-8-sig", newline="") as handle:
        for raw in csv.DictReader(handle):
            decision = (raw.get("Decision") or "").strip()
            if not decision:
                continue
            rows.append(
                Row(
                    item=raw.get("item") or raw.get("source term") or "",
                    count=int(raw.get("count") or 0),
                    share=0.0,
                    outlier=raw.get("Outlier?") or "",
                    suggested=decision,
                    extra={k: v for k, v in raw.items() if v},
                )
            )
    return rows


def termbase_import_csv(decided: list[Row], path: str | Path) -> Path:
    """`termbase-import.csv`: approved renderings *required*, rejected *forbidden*.

    qa-bootstrap-inventories.md → After the team verifies 2. Aquilla's import
    column order is `source term, rendering, status, notes`.
    """
    out = Path(path)
    with open(out, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["source term", "rendering", "status", "notes"])
        for row in decided:
            verdict = row.suggested.strip().lower()
            if verdict.startswith("approve"):
                status = "required"
            elif verdict.startswith("reject"):
                status = "forbidden"
            else:
                continue
            writer.writerow(
                [
                    row.extra.get("source term", row.item),
                    row.extra.get("rendering", ""),
                    status,
                    row.extra.get("notes", ""),
                ]
            )
    return out
