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

describe("ChapterNavigator", () => {
  it("keeps the current chapter and verse range visible", () => {
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={() => {}} />)
    expect(screen.getByRole("button", { name: /Current chapter: Matthew 1/ })).toHaveTextContent("Verses 1–25")
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
    fireEvent.click(screen.getByRole("button", { name: /Current chapter: Matthew 1/ }))
    expect(screen.getByRole("combobox", { name: "Find a chapter" })).toBeInTheDocument()
    fireEvent.click(screen.getByText("Matthew 2"))
    expect(onSelect).toHaveBeenCalledWith("MAT 2")
  })

  it.each(["13", "31"])("matches complete chapter number %s instead of a fuzzy digit sequence", (chapterNumber) => {
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /Current chapter: Matthew 1/ }))
    fireEvent.change(screen.getByRole("combobox", { name: "Find a chapter" }), {
      target: { value: chapterNumber },
    })

    expect(screen.getByRole("option", { name: new RegExp(`Matthew ${chapterNumber} `) })).toBeInTheDocument()
    for (const otherChapter of ["3", "13", "31"].filter((value) => value !== chapterNumber)) {
      expect(screen.queryByRole("option", { name: new RegExp(`Matthew ${otherChapter} `) })).not.toBeInTheDocument()
    }
  })

  it("shows no result when an exact numeric chapter does not exist", () => {
    render(<ChapterNavigator chapters={chapters} activeLabel="MAT 1" onSelect={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /Current chapter: Matthew 1/ }))
    fireEvent.change(screen.getByRole("combobox", { name: "Find a chapter" }), {
      target: { value: "30" },
    })

    expect(screen.getByText("No chapters found.")).toBeInTheDocument()
  })
})
