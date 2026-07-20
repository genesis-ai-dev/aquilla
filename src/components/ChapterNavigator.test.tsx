import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ChapterNavigator, type ChapterNavigationItem } from "./ChapterNavigator"

afterEach(cleanup)

const chapters: ChapterNavigationItem[] = [
  { label: "MAT 1", displayLabel: "Matthew 1", verseRange: "1–25", translated: 12, validated: 8, total: 25 },
  { label: "MAT 2", displayLabel: "Matthew 2", verseRange: "1–23", translated: 23, validated: 20, total: 23 },
  { label: "MAT 3", displayLabel: "Matthew 3", verseRange: "1–17", translated: 17, validated: 10, total: 17 },
  { label: "MAT 13", displayLabel: "Matthew 13", verseRange: "1–58", translated: 58, validated: 42, total: 58 },
  { label: "MAT 31", displayLabel: "Matthew 31", verseRange: "1–12", translated: 12, validated: 4, total: 12 },
]

function openChapterPicker(activeDisplayLabel = "Matthew 1") {
  fireEvent.click(screen.getByRole("combobox", { name: new RegExp(`Current chapter: ${activeDisplayLabel}`) }))
}

function chapterSearch() {
  return screen.getByRole("combobox", { name: "Find a chapter" })
}

describe("ChapterNavigator", () => {
  it("keeps the current chapter and verse range visible", () => {
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={() => {}} />)
    expect(screen.getByRole("combobox", { name: /Current chapter: Matthew 1/ })).toHaveTextContent("Verses 1–25")
    expect(screen.getByText("Verses 1–25")).toHaveClass("justify-self-center")
    expect(screen.getByRole("button", { name: "Previous chapter" })).toBeDisabled()
  })

  it("moves to the next chapter with one click", () => {
    const onSelect = vi.fn()
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }))
    expect(onSelect).toHaveBeenCalledWith("MAT 2")
  })

  it("opens an anchored searchable picker and selects a chapter", () => {
    const onSelect = vi.fn()
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={onSelect} />)
    openChapterPicker()
    expect(chapterSearch()).toBeInTheDocument()
    expect(chapterSearch().closest("[data-slot=input-group]")?.querySelector("svg.lucide-search")).toBeTruthy()
    fireEvent.click(screen.getByRole("option", { name: /Matthew 2/ }))
    expect(onSelect).toHaveBeenCalledWith("MAT 2")
  })

  it.each(["13", "31"])("matches complete chapter number %s instead of a fuzzy digit sequence", (chapterNumber) => {
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={() => {}} />)
    openChapterPicker()
    fireEvent.change(chapterSearch(), {
      target: { value: chapterNumber },
    })

    expect(screen.getByRole("option", { name: new RegExp(`Matthew ${chapterNumber} `) })).toBeInTheDocument()
    for (const otherChapter of ["3", "13", "31"].filter((value) => value !== chapterNumber)) {
      expect(screen.queryByRole("option", { name: new RegExp(`Matthew ${otherChapter} `) })).not.toBeInTheDocument()
    }
  })

  it("shows no result when an exact numeric chapter does not exist", () => {
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={() => {}} />)
    openChapterPicker()
    fireEvent.change(chapterSearch(), {
      target: { value: "30" },
    })

    expect(screen.getByText("No chapters found.")).toBeInTheDocument()
  })

  it("virtualizes a whole-Bible chapter list instead of mounting every option", () => {
    const manyChapters: ChapterNavigationItem[] = Array.from({ length: 1189 }, (_, index) => {
      const n = index + 1
      return {
        label: `GEN ${n}`,
        displayLabel: `Genesis ${n}`,
        verseRange: "1–1",
        translated: 0,
        validated: 0,
        total: 1,
      }
    })
    render(<ChapterNavigator chapters={manyChapters} activeLabel="GEN 1" onSelect={() => {}} />)
    openChapterPicker("Genesis 1")

    const options = screen.getAllByRole("option")
    expect(options.length).toBeGreaterThan(0)
    expect(options.length).toBeLessThan(manyChapters.length)
    expect(screen.getByRole("option", { name: /Genesis 1 / })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Genesis 1189 / })).not.toBeInTheDocument()
  })

  it("keeps Combobox keyboard navigation: ArrowDown then Enter selects the next chapter", () => {
    const onSelect = vi.fn()
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={onSelect} />)
    openChapterPicker()

    const search = chapterSearch()
    fireEvent.focus(search)
    fireEvent.keyDown(search, { key: "ArrowDown" })
    fireEvent.keyDown(search, { key: "Enter" })

    expect(onSelect).toHaveBeenCalledWith("MAT 2")
  })

  it("keeps Combobox keyboard navigation after filtering", () => {
    const onSelect = vi.fn()
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={onSelect} />)
    openChapterPicker()

    const search = chapterSearch()
    fireEvent.change(search, { target: { value: "13" } })
    expect(screen.getByRole("option", { name: /Matthew 13 / })).toHaveAttribute("data-highlighted")
    fireEvent.focus(search)
    fireEvent.keyDown(search, { key: "Enter" })

    expect(onSelect).toHaveBeenCalledWith("MAT 13")
  })

  it("selects a far chapter via filter autoHighlight and Enter", () => {
    const onSelect = vi.fn()
    const manyChapters: ChapterNavigationItem[] = Array.from({ length: 80 }, (_, index) => {
      const n = index + 1
      return {
        label: `PSA ${n}`,
        displayLabel: `Psalm ${n}`,
        verseRange: "1–1",
        translated: 0,
        validated: 0,
        total: 1,
      }
    })
    render(<ChapterNavigator chapters={manyChapters} activeLabel="PSA 1" onSelect={onSelect} />)
    openChapterPicker("Psalm 1")

    const search = chapterSearch()
    fireEvent.change(search, { target: { value: "31" } })
    expect(screen.getByRole("option", { name: /Psalm 31 / })).toHaveAttribute("data-highlighted")
    fireEvent.focus(search)
    fireEvent.keyDown(search, { key: "Enter" })

    expect(onSelect).toHaveBeenCalledWith("PSA 31")
  })
})
