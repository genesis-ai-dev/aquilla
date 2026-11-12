// AQU-1187: for a file spanning several books, the toolbar chapter picker files
// its options under book headings instead of offering one flat searchable list
// of 1,189 chapters. Headings label the browse list only — they never navigate,
// and they get out of the way the moment the user types.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MilestoneNavigator, type MilestoneNavigationItem } from "./ChapterNavigator"

afterEach(cleanup)

function chapter(book: string, name: string, number: number): MilestoneNavigationItem {
  return {
    key: `scripture:${book}:${number}`,
    kind: "chapter",
    label: `${name} ${number}`,
    shortLabel: String(number),
    description: "Verses 1–10",
    translated: 0,
    validated: 0,
    total: 10,
  }
}

const multiBook: MilestoneNavigationItem[] = [
  chapter("GEN", "Genesis", 1),
  chapter("GEN", "Genesis", 2),
  chapter("MAT", "Matthew", 5),
  chapter("MAT", "Matthew", 6),
]

function openPicker(triggerName: RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }))
}

function headings(): string[] {
  return screen
    .getAllByTestId("milestone-book-header")
    .map((el) => el.getAttribute("data-book") ?? "")
}

describe("MilestoneNavigator — book groups (AQU-1187)", () => {
  it("groups the options by book, in canonical order", () => {
    render(<MilestoneNavigator items={multiBook} activeKey="scripture:GEN:1" onSelect={vi.fn()} />)
    openPicker(/Current chapter: Genesis 1/)

    expect(headings()).toEqual(["Genesis", "Matthew"])
    expect(screen.getByRole("option", { name: /Genesis 1 / })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /Matthew 5 / })).toBeInTheDocument()
  })

  it("still finds a chapter by book name and number, and drops the headings while searching", () => {
    render(<MilestoneNavigator items={multiBook} activeKey="scripture:GEN:1" onSelect={vi.fn()} />)
    openPicker(/Current chapter: Genesis 1/)

    fireEvent.change(screen.getByRole("combobox", { name: "Find a chapter" }), {
      target: { value: "Matthew 5" },
    })

    expect(screen.getByRole("option", { name: /Matthew 5 / })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Genesis 1 / })).not.toBeInTheDocument()
    expect(screen.queryByTestId("milestone-book-header")).not.toBeInTheDocument()
  })

  it("never navigates from a heading, and still navigates from a chapter under one", () => {
    const onSelect = vi.fn()
    render(<MilestoneNavigator items={multiBook} activeKey="scripture:GEN:1" onSelect={onSelect} />)
    openPicker(/Current chapter: Genesis 1/)

    fireEvent.click(screen.getAllByTestId("milestone-book-header")[1])
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("option", { name: /Matthew 5 / }))
    expect(onSelect).toHaveBeenCalledWith("scripture:MAT:5")
  })

  it("adds no headings to a single-book file", () => {
    render(
      <MilestoneNavigator
        items={[chapter("MRK", "Mark", 1), chapter("MRK", "Mark", 2)]}
        activeKey="scripture:MRK:1"
        onSelect={vi.fn()}
      />,
    )
    openPicker(/Current chapter: Mark 1/)

    expect(screen.queryByTestId("milestone-book-header")).not.toBeInTheDocument()
    expect(screen.getByRole("option", { name: /Mark 2 / })).toBeInTheDocument()
  })

  it("adds no headings to a file with no scripture references", () => {
    const parts: MilestoneNavigationItem[] = [
      { key: "part:1", kind: "section", label: "Part 1", shortLabel: "1", description: "50 cells", translated: 0, validated: 0, total: 50 },
      { key: "part:2", kind: "section", label: "Part 2", shortLabel: "2", description: "50 cells", translated: 0, validated: 0, total: 50 },
    ]
    render(<MilestoneNavigator items={parts} activeKey="part:1" onSelect={vi.fn()} />)
    openPicker(/Current section: Part 1/)

    expect(screen.queryByTestId("milestone-book-header")).not.toBeInTheDocument()
  })
})
