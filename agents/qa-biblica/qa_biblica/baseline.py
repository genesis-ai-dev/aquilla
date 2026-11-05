"""The verified baseline — the standard every Pass 1-3 check reports against.

`skills/qa-run-book.md` → Before you start requires the baseline to exist, and
every mechanical skill says the same thing in its own words: *"If they are
missing, stop and suggest running the bootstrap first. Never invent an approved
set."* So `load_baseline` either finds the entries or returns a `Baseline` that
says what is missing, and the orchestrator stops.

**Where the lists live.** The skills name them `style/characters`,
`glossary/wordlist-approved` and so on. The Agent API's memory paths are a flat
namespace per kind (`decisions/<slug>.md`, slug `^[a-z0-9]+(-[a-z0-9]+)*$` —
`sync-worker/src/external/commands-memory.ts`), so the prefix cannot survive as
a slash. `stage.baseline_slug` folds it in: `style/characters` →
`decisions/qa-style-characters.md`. The skills are left unedited; the mapping is
in the runner's README, which is the trade the issue chose.

**The body format** is the runner's own, because the runner both writes it (the
bootstrap's after-verification step) and reads it back. It is deliberately
line-oriented and boring so a mentor can read and hand-edit it in the Memory
page without breaking the parse: a `key: value` header block, then `- item`
lines under a `items:` marker.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .stage import baseline_slug

#: The baseline paths qa-run-book.md checks for before it will run.
REQUIRED_PATHS: tuple[str, ...] = (
    "style/characters",
    "style/punctuation",
    "style/conventions",
    "glossary/wordlist-approved",
)

#: Every path the bootstrap can produce, required or not.
ALL_PATHS: tuple[str, ...] = REQUIRED_PATHS + (
    "style/quotations",
    "style/grammar-profile",
    "glossary/wordlist-incorrect",
    "glossary/names",
)


@dataclass
class Baseline:
    """Parsed baseline lists. Empty collections mean "verified as empty"; a path
    in `missing` means the list was never verified at all."""

    #: Approved characters, NFC, as single-character strings.
    characters: set[str] = field(default_factory=set)
    #: Mark → spacing pattern, e.g. `","` → `"none|space"` (before|after).
    punctuation: dict[str, str] = field(default_factory=dict)
    #: Nesting level (1-based) → (opening mark, closing mark).
    quotations: list[tuple[str, str]] = field(default_factory=list)
    #: Convention name → approved form, e.g. `"Law"` → `"Law"`.
    conventions: dict[str, str] = field(default_factory=dict)
    #: Number style per size band: `"1-10"` → `"words"` | `"digits"`.
    number_style: dict[str, str] = field(default_factory=dict)
    approved_words: set[str] = field(default_factory=set)
    #: Known-wrong word → the approved spelling.
    incorrect_words: dict[str, str] = field(default_factory=dict)
    #: Name → approved spelling.
    names: dict[str, str] = field(default_factory=dict)
    abbreviations: set[str] = field(default_factory=set)
    #: Verified affixes from `style/grammar-profile`, used to recognize
    #: inflected forms instead of flagging them as spelling variants.
    prefixes: tuple[str, ...] = ()
    suffixes: tuple[str, ...] = ()
    #: False for a script with no upper/lower case — capitalization is skipped
    #: and the report says so (qa-capitalization-numbers.md → Baseline).
    cased_script: bool = True
    #: ISO date the baseline was verified; the report header cites it.
    verified_on: str = ""
    #: Required paths with no approved entry.
    missing: tuple[str, ...] = ()

    #: Lazily-built casefold index of `approved_words`, with the size it was
    #: built from so a later edit to the list rebuilds it.
    _folded: tuple[int, frozenset[str]] | None = field(default=None, repr=False, compare=False)

    @property
    def complete(self) -> bool:
        return not self.missing

    def approved_casefolded(self) -> frozenset[str]:
        """`approved_words`, casefolded.

        Spelling does not own case. A sentence-initial capital differs from its
        lowercase wordlist entry by case alone, and `qa-capitalization-numbers`
        is the pass that owns capitalization — reporting it here too would
        double-report one issue, which every skill file forbids. So Pass 2
        matches case-insensitively and leaves case to Pass 1.
        """
        if self._folded is None or self._folded[0] != len(self.approved_words):
            self._folded = (
                len(self.approved_words),
                frozenset(word.casefold() for word in self.approved_words),
            )
        return self._folded[1]

    @property
    def missing_message(self) -> str:
        paths = [m for m in self.missing if "/" in m]
        others = [m for m in self.missing if "/" not in m]
        parts: list[str] = []
        if paths:
            parts.append("no approved memory entry for " + ", ".join(paths))
        parts.extend(others)
        return (
            "the verified baseline is incomplete — "
            + "; ".join(parts)
            + ". Run qa-bootstrap-inventories on the approved books first "
            "(qa-run-book.md → Before you start)."
        )


def load_baseline(memory: dict, *, terms: list[dict] | None = None) -> Baseline:
    """Build a `Baseline` from a `GET …/memory` response.

    Only **approved** entries count. A proposed entry is a suggestion the team
    has not accepted, and treating it as the standard would be the runner
    approving its own homework.
    """
    by_slug: dict[str, str] = {}
    for entry in memory.get("data") or []:
        if entry.get("status") != "approved":
            continue
        path = str(entry.get("path") or "")
        slug = path.rsplit("/", 1)[-1].removesuffix(".md")
        by_slug[slug] = str(entry.get("content") or "")

    baseline = Baseline()
    missing: list[str] = []
    for path in ALL_PATHS:
        content = by_slug.get(baseline_slug(path))
        if content is None:
            if path in REQUIRED_PATHS:
                missing.append(path)
            continue
        _apply(baseline, path, parse_block(content))
    baseline.missing = tuple(missing)

    # Active termbase concepts are the other half of the baseline
    # (qa-run-book.md → Before you start). Their absence is reported by
    # qa-key-terms-names, which can say which concepts it expected.
    if terms is not None and not any(t.get("status") == "active" for t in terms):
        baseline.missing = baseline.missing + (
            "the termbase has no active concept, so no key term is enforced yet",
        )
    return baseline


# ---------------------------------------------------------------------------
# The block format
# ---------------------------------------------------------------------------


@dataclass
class Block:
    headers: dict[str, str] = field(default_factory=dict)
    items: list[str] = field(default_factory=list)


def parse_block(content: str) -> Block:
    """Parse the runner's baseline body: headers, then `- item` lines.

    Unknown headers and stray prose are ignored rather than rejected: a mentor
    adding a sentence of context to an entry must not break the next run.
    """
    block = Block()
    in_items = False
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.rstrip(":").lower() == "items":
            in_items = True
            continue
        if line.startswith("- "):
            block.items.append(line[2:].strip())
            continue
        if not in_items and ":" in line:
            key, _, value = line.partition(":")
            block.headers[key.strip().lower()] = value.strip()
    return block


def render_block(headers: dict[str, str], items: list[str]) -> str:
    """Inverse of `parse_block`, so a written baseline reads back identically."""
    lines = [f"{key}: {value}" for key, value in headers.items()]
    if items:
        lines.append("items:")
        lines.extend(f"- {item}" for item in items)
    return "\n".join(lines)


def _apply(baseline: Baseline, path: str, block: Block) -> None:
    if block.headers.get("verified"):
        baseline.verified_on = block.headers["verified"]

    if path == "style/characters":
        for item in block.items:
            char = _first_field(item)
            if char:
                baseline.characters.add(char)
        if "cased" in block.headers:
            baseline.cased_script = block.headers["cased"].lower() not in {"no", "false", "0"}
        return

    if path == "style/punctuation":
        for item in block.items:
            mark, _, pattern = item.partition("=")
            if mark.strip():
                baseline.punctuation[mark.strip()] = pattern.strip() or "any"
        for abbreviation in _csv(block.headers.get("abbreviations", "")):
            baseline.abbreviations.add(abbreviation)
        return

    if path == "style/quotations":
        for item in block.items:
            parts = item.split()
            if len(parts) >= 2:
                baseline.quotations.append((parts[0], parts[1]))
        return

    if path == "style/conventions":
        for item in block.items:
            key, _, value = item.partition("=")
            key, value = key.strip(), value.strip()
            if not key:
                continue
            if key.startswith("numbers "):
                baseline.number_style[key[len("numbers ") :].strip()] = value
            else:
                baseline.conventions[key] = value or key
        return

    if path == "glossary/wordlist-approved":
        baseline.approved_words.update(_first_field(i) for i in block.items if _first_field(i))
        return

    if path == "glossary/wordlist-incorrect":
        for item in block.items:
            wrong, _, right = item.partition("=")
            if wrong.strip():
                baseline.incorrect_words[wrong.strip()] = right.strip()
        return

    if path == "glossary/names":
        for item in block.items:
            name, _, approved = item.partition("=")
            if name.strip():
                baseline.names[name.strip()] = approved.strip() or name.strip()
        return

    if path == "style/grammar-profile":
        baseline.prefixes = tuple(_csv(block.headers.get("prefixes", "")))
        baseline.suffixes = tuple(_csv(block.headers.get("suffixes", "")))
        return


def _first_field(item: str) -> str:
    """The item up to the first tab or double space — the rest is annotation."""
    for separator in ("\t", "  ", " |"):
        if separator in item:
            return item.split(separator, 1)[0].strip()
    return item.strip()


def _csv(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]
