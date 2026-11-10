"""Scope parsing — the three modes in `skills/qa-run-book.md` → Scope modes.

The operator types the same phrases Biblica's install guide teaches, so the
runner accepts them literally:

    MRK                                  → remaining book, passes 1-5
    ROM 3                                → single chapter, passes 1-4
    approved books, edited cells only    → passes 1-3 on cells edited since approval

Nothing here talks to the API: a scope is a plain value the reader resolves
against the project's files.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum


class ScopeMode(str, Enum):
    BOOK = "book"
    CHAPTER = "chapter"
    APPROVED_EDITED = "approved-edited"


#: Which passes each mode runs (qa-run-book.md → Scope modes). Pass 5 is
#: book-level, so it never runs on a chapter or on an edited-cells sweep.
PASSES_BY_MODE: dict[ScopeMode, tuple[int, ...]] = {
    ScopeMode.BOOK: (1, 2, 3, 4, 5),
    ScopeMode.CHAPTER: (1, 2, 3, 4),
    ScopeMode.APPROVED_EDITED: (1, 2, 3),
}

_BOOK_RE = re.compile(r"^[1-3]?[A-Z]{2,3}$")
_CHAPTER_RE = re.compile(r"^([1-3]?[A-Z]{2,3})\s+(\d{1,3})$")
_EDITED_RE = re.compile(r"^approved books,?\s*edited cells only$", re.IGNORECASE)


class ScopeError(ValueError):
    """The scope phrase is not one of qa-run-book.md's three modes."""


@dataclass(frozen=True)
class Scope:
    mode: ScopeMode
    #: Book codes in scope. For APPROVED_EDITED this is the approved-books list.
    books: tuple[str, ...]
    chapter: int | None = None
    #: Approval date for APPROVED_EDITED, as epoch ms. Cells whose last edit is
    #: at or before this instant are out of scope and produce no findings.
    edited_since_ms: int | None = None
    #: Optional `since=<serverSeq>` cursor for the cells endpoint. When set, the
    #: edited set comes from the API's own delta read rather than from
    #: `lastEditAt` arithmetic.
    since_seq: int | None = None

    @property
    def passes(self) -> tuple[int, ...]:
        return PASSES_BY_MODE[self.mode]

    @property
    def label(self) -> str:
        if self.mode is ScopeMode.CHAPTER:
            return f"{self.books[0]} {self.chapter}"
        if self.mode is ScopeMode.APPROVED_EDITED:
            books = ", ".join(self.books) if self.books else "(none listed)"
            return f"approved books, edited cells only [{books}]"
        return self.books[0]

    def includes(self, book: str, chapter: int | None) -> bool:
        if book not in self.books:
            return False
        if self.mode is ScopeMode.CHAPTER:
            return chapter == self.chapter
        return True


def parse_scope(
    phrase: str,
    *,
    approved_books: tuple[str, ...] = (),
    edited_since: str | None = None,
    since_seq: int | None = None,
) -> Scope:
    """Parse one of the three scope phrases.

    `approved_books` and `edited_since` only matter for the edited-cells mode;
    both come from the project brief / the operator's approved-books file, never
    from the model.
    """
    text = phrase.strip().strip("[]").strip()
    if not text:
        raise ScopeError("empty scope")

    if _EDITED_RE.match(text):
        if not approved_books:
            raise ScopeError(
                "'approved books, edited cells only' needs the approved-books list "
                "(--approved-books); the brief names it and the runner will not guess"
            )
        if edited_since is None:
            raise ScopeError(
                "'approved books, edited cells only' needs the approval date "
                "(--edited-since YYYY-MM-DD): without it every cell looks edited"
            )
        return Scope(
            mode=ScopeMode.APPROVED_EDITED,
            books=approved_books,
            edited_since_ms=parse_date_ms(edited_since),
            since_seq=since_seq,
        )

    chapter_match = _CHAPTER_RE.match(text.upper())
    if chapter_match:
        return Scope(
            mode=ScopeMode.CHAPTER,
            books=(chapter_match.group(1),),
            chapter=int(chapter_match.group(2)),
        )

    upper = text.upper()
    if _BOOK_RE.match(upper):
        return Scope(mode=ScopeMode.BOOK, books=(upper,))

    raise ScopeError(
        f"{phrase!r} is not a scope qa-run-book.md defines. Use a book (MRK), "
        "a chapter (ROM 3), or 'approved books, edited cells only'."
    )


def parse_date_ms(value: str) -> int:
    """`YYYY-MM-DD` (or a full ISO-8601 instant) → epoch milliseconds, UTC."""
    text = value.strip()
    try:
        if len(text) == 10:
            parsed = datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        else:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ScopeError(f"{value!r} is not a date (expected YYYY-MM-DD)") from exc
    return int(parsed.timestamp() * 1000)


def read_approved_books(path: str) -> tuple[str, ...]:
    """Read the approved-books list the operator keeps on disk.

    One book code per line, or a single comma-separated line; `#` comments and
    blank lines ignored. The file is an operator input, not an API read — the
    bootstrap must never mine a book that is not on it
    (qa-bootstrap-inventories.md → Do not).
    """
    books: list[str] = []
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            for token in line.replace(",", " ").split():
                code = token.strip().upper()
                if not _BOOK_RE.match(code):
                    raise ScopeError(f"{path}: {token!r} is not a book code")
                if code not in books:
                    books.append(code)
    if not books:
        raise ScopeError(f"{path}: no book codes found")
    return tuple(books)
