// AQU-1187: a file that spans several books (a whole-Bible eBible/Hello AO
// import made before the per-book split) shows a collapsible header per book in
// the expanded sidebar row, instead of one flat spine of every chapter in the
// Bible. Per-book files and non-scripture files must look exactly as they did.

import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BookHealthSpine, type BookHealthChapter } from "./BookHealthSpine"

const COLLAPSE_KEY = "aquilla:sidebar:book-collapsed:p-1:f-1"

/** Chapters as the active file supplies them: milestone keys carry the book. */
const wholeBible: BookHealthChapter[] = [
  { key: "scripture:GEN:1", label: "Genesis 1", translated: 1, validated: 1, total: 2 },
  { key: "scripture:GEN:2", label: "Genesis 2", translated: 0, validated: 0, total: 2 },
  { key: "scripture:MAT:1", label: "Matthew 1", translated: 2, validated: 2, total: 2 },
]

function bookNames(): string[] {
  return screen.getAllByTestId("book-health-book").map((el) => el.getAttribute("data-book") ?? "")
}

function chapterLabels(): string[] {
  return screen
    .getAllByTestId("book-health-chapter")
    .map((el) => el.getAttribute("data-chapter-label") ?? "")
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe("BookHealthSpine — book tree for multi-book files", () => {
  it("shows one header per book, in canonical order, with that book's chapters beneath", () => {
    render(
      <BookHealthSpine
        chapters={[wholeBible[2], wholeBible[0], wholeBible[1]]}
        onChapterClick={vi.fn()}
        bookCollapseStorageKey={COLLAPSE_KEY}
      />,
    )

    expect(bookNames()).toEqual(["Genesis", "Matthew"])
    expect(chapterLabels()).toEqual(["Genesis 1", "Genesis 2", "Matthew 1"])
  })

  it("collapses and expands a book, and persists the collapse like a corpus group", () => {
    const { unmount } = render(
      <BookHealthSpine
        chapters={wholeBible}
        onChapterClick={vi.fn()}
        bookCollapseStorageKey={COLLAPSE_KEY}
      />,
    )

    const toggles = screen.getAllByTestId("book-health-book-toggle")
    expect(toggles[0]).toHaveAttribute("aria-expanded", "true")
    fireEvent.click(toggles[0])

    expect(screen.getAllByTestId("book-health-book-toggle")[0]).toHaveAttribute("aria-expanded", "false")
    // Genesis folded away; Matthew untouched. Headers all stay visible.
    expect(chapterLabels()).toEqual(["Matthew 1"])
    expect(bookNames()).toEqual(["Genesis", "Matthew"])

    // A remount reads the persisted state back, so a folded book stays folded.
    unmount()
    render(
      <BookHealthSpine
        chapters={wholeBible}
        onChapterClick={vi.fn()}
        bookCollapseStorageKey={COLLAPSE_KEY}
      />,
    )
    expect(chapterLabels()).toEqual(["Matthew 1"])

    fireEvent.click(screen.getAllByTestId("book-health-book-toggle")[0])
    expect(chapterLabels()).toEqual(["Genesis 1", "Genesis 2", "Matthew 1"])
  })

  it("keeps collapse state separate per file", () => {
    const { unmount } = render(
      <BookHealthSpine
        chapters={wholeBible}
        onChapterClick={vi.fn()}
        bookCollapseStorageKey={COLLAPSE_KEY}
      />,
    )
    fireEvent.click(screen.getAllByTestId("book-health-book-toggle")[0])
    expect(chapterLabels()).toEqual(["Matthew 1"])
    unmount()

    render(
      <BookHealthSpine
        chapters={wholeBible}
        onChapterClick={vi.fn()}
        bookCollapseStorageKey="aquilla:sidebar:book-collapsed:p-1:f-2"
      />,
    )
    expect(chapterLabels()).toEqual(["Genesis 1", "Genesis 2", "Matthew 1"])
  })

  it("jumps to a chapter under a book header exactly as the flat spine does", () => {
    const onChapterClick = vi.fn()
    render(
      <BookHealthSpine
        chapters={wholeBible}
        onChapterClick={onChapterClick}
        bookCollapseStorageKey={COLLAPSE_KEY}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Matthew 1" }))
    expect(onChapterClick).toHaveBeenCalledWith("Matthew 1")
  })

  it("renders no book headers for a per-book scripture file", () => {
    render(
      <BookHealthSpine
        chapters={[
          { key: "scripture:MRK:1", label: "Mark 1", translated: 0, validated: 0, total: 1 },
          { key: "scripture:MRK:2", label: "Mark 2", translated: 0, validated: 0, total: 1 },
        ]}
        onChapterClick={vi.fn()}
        bookCollapseStorageKey={COLLAPSE_KEY}
      />,
    )

    expect(screen.queryByTestId("book-health-book")).not.toBeInTheDocument()
    expect(chapterLabels()).toEqual(["Mark 1", "Mark 2"])
  })

  it("renders no book headers for a file with no scripture references", () => {
    render(
      <BookHealthSpine
        chapters={[
          { key: "part:1", label: "Part 1", translated: 0, validated: 0, total: 1 },
          { key: "part:2", label: "Part 2", translated: 0, validated: 0, total: 1 },
        ]}
        onChapterClick={vi.fn()}
        bookCollapseStorageKey={COLLAPSE_KEY}
      />,
    )

    expect(screen.queryByTestId("book-health-book")).not.toBeInTheDocument()
    expect(chapterLabels()).toEqual(["Part 1", "Part 2"])
  })

  it("groups a legacy whole-Bible file whose chapter keys are just labels", () => {
    // The /progress path sets key = label, so grouping has to survive it — this
    // is the case that covers existing production whole-Bible files.
    render(
      <BookHealthSpine
        chapters={[
          { key: "Genesis 1", label: "Genesis 1", translated: 0, validated: 0, total: 1, percentagesOnly: true },
          { key: "Revelation 1", label: "Revelation 1", translated: 0, validated: 0, total: 1, percentagesOnly: true },
        ]}
        onChapterClick={vi.fn()}
        bookCollapseStorageKey={COLLAPSE_KEY}
      />,
    )

    expect(bookNames()).toEqual(["Genesis", "Revelation"])
  })
})
