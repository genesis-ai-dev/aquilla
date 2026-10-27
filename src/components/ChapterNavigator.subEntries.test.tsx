// AQU-2190 — how the picker renders a sub-entry someone NAMED, next to the
// automatic cell ranges a long division has always listed.
//
// The rows are the same nested-row shape either way; what differs is the label.
// An automatic range is framed as one ("Cells 51–100") because "51–100" alone
// says nothing; a name is content and is shown exactly as typed — framing a
// pericope title as "Cells The calming of the storm" is the regression this
// guards.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MilestoneNavigator, type MilestoneNavigationItem } from "./ChapterNavigator"

afterEach(cleanup)

/** Mark 4, with the verses above the marker still numbered as a range. */
const markChapter: MilestoneNavigationItem[] = [
  {
    key: "scripture:MRK:4",
    kind: "chapter",
    label: "Mark 4",
    shortLabel: "4",
    description: "Verses 1–41",
    translated: 0,
    validated: 0,
    total: 41,
    subsections: [
      { key: "scripture:MRK:4:range:c1", label: "1–34", firstCellId: "c1", translated: 0, validated: 0, total: 34 },
      {
        key: "scripture:MRK:4:handset:c35",
        label: "The calming of the storm",
        firstCellId: "c35",
        handSet: true,
        translated: 0,
        validated: 0,
        total: 7,
      },
    ],
  },
]

function openPicker() {
  fireEvent.click(screen.getByRole("combobox", { name: /Current chapter: Mark 4/ }))
}

describe("MilestoneNavigator — named sub-entries (AQU-2190)", () => {
  it("shows a named sub-entry as typed and an automatic range framed as cells", () => {
    render(<MilestoneNavigator items={markChapter} activeKey="scripture:MRK:4" onSelect={() => {}} />)
    openPicker()

    expect(screen.getByRole("option", { name: /The calming of the storm/ })).toBeInTheDocument()
    // …and not framed as a cell range, which is what the name would read as if
    // the two kinds of sub-entry shared one label format.
    expect(screen.queryByRole("option", { name: /Cells The calming of the storm/ }))
      .not.toBeInTheDocument()
    // The range above it is untouched.
    expect(screen.getByRole("option", { name: /Cells 1–34/ })).toBeInTheDocument()
  })

  it("navigates to the sub-entry's own key when it is picked", () => {
    const onSelect = vi.fn()
    render(<MilestoneNavigator items={markChapter} activeKey="scripture:MRK:4" onSelect={onSelect} />)
    openPicker()
    fireEvent.click(screen.getByRole("option", { name: /The calming of the storm/ }))

    // Keyed by the marked cell, so the jump lands on that verse rather than on
    // the chapter's first.
    expect(onSelect).toHaveBeenCalledWith("scripture:MRK:4", "scripture:MRK:4:handset:c35")
  })

  it("finds a sub-entry by its name in the picker's search", () => {
    render(<MilestoneNavigator items={markChapter} activeKey="scripture:MRK:4" onSelect={() => {}} />)
    openPicker()
    fireEvent.change(screen.getByRole("combobox", { name: "Find a chapter" }), {
      target: { value: "calming" },
    })

    expect(screen.getByRole("option", { name: /The calming of the storm/ })).toBeInTheDocument()
  })
})
