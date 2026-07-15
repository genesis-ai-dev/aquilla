import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ChapterNavigator, type ChapterNavigationItem } from "./ChapterNavigator"

afterEach(cleanup)

const chapters: ChapterNavigationItem[] = [
  { label: "MAT 1", displayLabel: "Matthew 1", verseRange: "1–25", translated: 12, validated: 8, total: 25 },
  { label: "MAT 2", displayLabel: "Matthew 2", verseRange: "1–23", translated: 23, validated: 20, total: 23 },
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
})
