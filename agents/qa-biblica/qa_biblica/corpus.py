"""The normalized corpus every checker reads.

The Agent API serves source and target as *separate rows* sharing a `cellId`
(`sync-worker/src/events/cells-read-route.ts` → `CellRowOut.side`). Checkers
want verses, not rows, so `build_corpus` pairs them once and writes the result
to JSONL on disk. That file is the run's evidence: every count, inventory and
verse list in a report is derived from it, which is what lets the report state
an API snapshot time and mean it.

Everything is NFC-normalized on the way in (`qa-text-integrity.md` → Encoding,
`qa-bootstrap-inventories.md` → Characters), and the pre-normalization form is
kept per verse so the "text is not NFC-normalized" check can still fire.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from typing import Iterable, Iterator, Sequence

#: `BOOK C:V`, the reference shape qa-chapter-verse.md reads structure from.
REF_RE = re.compile(r"^\s*([1-3]?[A-Z]{2,3})\s+(\d{1,3}):(\d{1,3})([a-z]?)\s*$")
#: A verse bridge: `MRK 1:1-2`.
BRIDGE_RE = re.compile(r"^\s*([1-3]?[A-Z]{2,3})\s+(\d{1,3}):(\d{1,3})-(\d{1,3})\s*$")


@dataclass(frozen=True)
class Ref:
    book: str
    chapter: int
    verse: int
    #: Last verse of a bridge; equal to `verse` for an ordinary reference.
    end_verse: int = 0

    def __post_init__(self) -> None:
        if self.end_verse == 0:
            object.__setattr__(self, "end_verse", self.verse)

    @property
    def is_bridge(self) -> bool:
        return self.end_verse > self.verse

    @property
    def verses(self) -> tuple[int, ...]:
        return tuple(range(self.verse, self.end_verse + 1))

    @property
    def sort_key(self) -> tuple[str, int, int]:
        return (self.book, self.chapter, self.verse)

    def __str__(self) -> str:
        if self.is_bridge:
            return f"{self.book} {self.chapter}:{self.verse}-{self.end_verse}"
        return f"{self.book} {self.chapter}:{self.verse}"


def parse_ref(raw: str | None) -> Ref | None:
    """Parse a `canonicalRef`. Returns None for a ref the runner cannot place."""
    if not raw:
        return None
    bridge = BRIDGE_RE.match(raw)
    if bridge:
        return Ref(bridge.group(1), int(bridge.group(2)), int(bridge.group(3)), int(bridge.group(4)))
    simple = REF_RE.match(raw)
    if simple:
        return Ref(simple.group(1), int(simple.group(2)), int(simple.group(3)))
    return None


@dataclass
class Verse:
    """One source/target pair, which is what every skill calls a 'cell'."""

    cell_id: str
    file_id: str
    ref: Ref | None
    raw_ref: str
    source: str
    target: str
    #: Target text exactly as the API served it, before NFC normalization.
    target_raw: str = ""
    validated: bool = False
    ai_drafted: bool = False
    last_editor: str | None = None
    last_edit_at: int = 0
    lane_id: str | None = None
    #: Position of the verse in its file, so "the cell before / after" is cheap.
    index: int = 0

    @property
    def book(self) -> str:
        return self.ref.book if self.ref else ""

    @property
    def chapter(self) -> int | None:
        return self.ref.chapter if self.ref else None

    @property
    def ref_label(self) -> str:
        return str(self.ref) if self.ref else (self.raw_ref or self.cell_id)

    @property
    def has_source(self) -> bool:
        return bool(self.source.strip())

    @property
    def has_target(self) -> bool:
        return bool(self.target.strip())

    @property
    def is_nfc(self) -> bool:
        """Whether the text **as stored** is already NFC.

        Compared against `target_raw`, not `target`: `target` is normalized on
        the way in, so comparing it with its own NFC form is always true and the
        check would never fire (qa-text-integrity.md → Encoding).
        """
        stored = self.target_raw or self.target
        return stored == unicodedata.normalize("NFC", stored)


@dataclass
class Corpus:
    """Every verse the run read, plus the snapshot metadata the report cites."""

    project_id: str
    lane_id: str
    snapshot_at: str
    verses: list[Verse] = field(default_factory=list)
    #: fileId → file name, for the "wrong book name" and report headings.
    file_names: dict[str, str] = field(default_factory=dict)

    def __iter__(self) -> Iterator[Verse]:
        return iter(self.verses)

    def __len__(self) -> int:
        return len(self.verses)

    def books(self) -> list[str]:
        seen: list[str] = []
        for verse in self.verses:
            if verse.book and verse.book not in seen:
                seen.append(verse.book)
        return seen

    def by_book(self, book: str) -> list[Verse]:
        return [v for v in self.verses if v.book == book]

    def first_verse(self) -> Verse | None:
        """The anchor for the run's report comment (qa-run-book.md → 7)."""
        return self.verses[0] if self.verses else None

    def filter(self, predicate) -> "Corpus":
        return Corpus(
            project_id=self.project_id,
            lane_id=self.lane_id,
            snapshot_at=self.snapshot_at,
            verses=[v for v in self.verses if predicate(v)],
            file_names=dict(self.file_names),
        )

    # -- persistence ------------------------------------------------------

    def write_jsonl(self, path: str) -> int:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "_meta": {
                            "projectId": self.project_id,
                            "laneId": self.lane_id,
                            "snapshotAt": self.snapshot_at,
                            "verses": len(self.verses),
                            "fileNames": self.file_names,
                        }
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            for verse in self.verses:
                row = asdict(verse)
                row["ref"] = str(verse.ref) if verse.ref else None
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        return len(self.verses)


def normalize(text: str | None) -> str:
    """NFC, with the no-break space kept (it is a real spacing choice)."""
    if not text:
        return ""
    return unicodedata.normalize("NFC", text)


def build_corpus(
    rows: Iterable[dict],
    *,
    project_id: str,
    lane_id: str,
    snapshot_at: str,
    file_id: str,
    start_index: int = 0,
) -> list[Verse]:
    """Pair one file's source/target rows into verses, in served order.

    Served order is the file's own cell order, so `index` is the order a
    neighbour check ("the cell before / after") must use.
    """
    sources: dict[str, dict] = {}
    targets: dict[str, dict] = {}
    order: list[str] = []
    for row in rows:
        cell_id = row.get("cellId")
        if not cell_id:
            continue
        if row.get("side") == "source":
            sources[cell_id] = row
            if cell_id not in order:
                order.append(cell_id)
        elif row.get("side") == "target":
            targets[cell_id] = row
            if cell_id not in order:
                order.append(cell_id)

    verses: list[Verse] = []
    for position, cell_id in enumerate(order):
        source_row = sources.get(cell_id, {})
        target_row = targets.get(cell_id, {})
        raw_ref = source_row.get("canonicalRef") or target_row.get("canonicalRef") or ""
        target_raw = target_row.get("value") or ""
        verses.append(
            Verse(
                cell_id=cell_id,
                file_id=file_id,
                ref=parse_ref(raw_ref),
                raw_ref=raw_ref,
                source=normalize(source_row.get("value")),
                target=normalize(target_raw),
                target_raw=target_raw,
                validated=bool(target_row.get("validated")),
                ai_drafted=bool(target_row.get("aiDrafted")),
                last_editor=target_row.get("lastEditor"),
                last_edit_at=int(target_row.get("lastEditAt") or 0),
                lane_id=target_row.get("laneId") or lane_id,
                index=start_index + position,
            )
        )
    return verses


def tokenize(text: str, *, word_chars: str = "'’-") -> list[str]:
    """Words, as `qa-spelling-wordlist.md` → Procedure 1 defines them.

    NFC-normalized, punctuation stripped, with internal hyphens and apostrophes
    kept when the baseline treats them as word characters.
    """
    normalized = normalize(text)
    out: list[str] = []
    current: list[str] = []
    for char in normalized:
        if char.isalnum() or (char in word_chars and current):
            current.append(char)
        elif current:
            out.append("".join(current).strip(word_chars))
            current = []
    if current:
        out.append("".join(current).strip(word_chars))
    return [w for w in out if w]


def sentences(text: str) -> list[str]:
    """Split on sentence-end marks, keeping it script-agnostic."""
    parts = re.split(r"[.!?؟。！？]+\s*", normalize(text))
    return [p.strip() for p in parts if p.strip()]


def ngrams(words: Sequence[str], size: int) -> list[tuple[str, ...]]:
    if len(words) < size:
        return []
    return [tuple(words[i : i + size]) for i in range(len(words) - size + 1)]
