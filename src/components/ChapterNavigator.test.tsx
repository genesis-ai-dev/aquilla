import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MilestoneNavigator, type MilestoneNavigationItem } from "./ChapterNavigator"

afterEach(cleanup)

const chapters: MilestoneNavigationItem[] = [
  { key: "scripture:MAT:1", kind: "chapter", label: "Matthew 1", shortLabel: "1", description: "Verses 1–25", translated: 12, validated: 8, total: 25 },
  { key: "scripture:MAT:2", kind: "chapter", label: "Matthew 2", shortLabel: "2", description: "Verses 1–23", translated: 23, validated: 20, total: 23 },
  { key: "scripture:MAT:3", kind: "chapter", label: "Matthew 3", shortLabel: "3", description: "Verses 1–17", translated: 17, validated: 10, total: 17 },
  { key: "scripture:MAT:13", kind: "chapter", label: "Matthew 13", shortLabel: "13", description: "Verses 1–58", translated: 58, validated: 42, total: 58 },
  { key: "scripture:MAT:31", kind: "chapter", label: "Matthew 31", shortLabel: "31", description: "Verses 1–12", translated: 12, validated: 4, total: 12 },
]

const stories: MilestoneNavigationItem[] = [
  {
    key: "story:u44d21",
    kind: "story",
    label: "Story u44d21",
    shortLabel: "21",
    description: "1 cell",
    translated: 0,
    validated: 0,
    total: 1,
    subsections: [
      { key: "story:u44d21:range:c1", label: "1–1", firstCellId: "c1", translated: 0, validated: 0, total: 1 },
    ],
  },
  {
    key: "story:u363",
    kind: "story",
    label: "Story u363",
    shortLabel: "363",
    description: "117 cells",
    translated: 55,
    validated: 5,
    total: 117,
    subsections: [
      { key: "story:u363:range:c2", label: "1–50", firstCellId: "c2", translated: 50, validated: 5, total: 50 },
      { key: "story:u363:range:c52", label: "51–100", firstCellId: "c52", translated: 5, validated: 0, total: 50 },
      { key: "story:u363:range:c102", label: "101–117", firstCellId: "c102", translated: 0, validated: 0, total: 17 },
    ],
  },
]

function openPicker(triggerName: RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }))
}

function pickerSearch(vocabulary = "chapter") {
  return screen.getByRole("combobox", { name: `Find a ${vocabulary}` })
}

describe("MilestoneNavigator", () => {
  it("keeps the current chapter and its verse range visible, fixed-width from xl up", () => {
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={() => {}} />)
    const trigger = screen.getByRole("combobox", { name: /Current chapter: Matthew 1/ })
    expect(trigger).toHaveTextContent("Matthew 1")
    expect(trigger).toHaveTextContent("Verses 1–25")
    expect(trigger).toHaveClass("min-w-8")
    expect(trigger).toHaveClass("justify-center")
    expect(trigger).toHaveClass("px-2.5")
    expect(trigger).toHaveClass("gap-2")
    expect(trigger).toHaveClass("shrink")
    expect(trigger).toHaveClass("data-[icon-only]:shrink-0")
    expect(trigger).toHaveClass("xl:w-56")
    expect(trigger).toHaveClass("flex")
    expect(trigger).toHaveClass("items-center")
    // Collapsed floor: prev + chevron + next (three size-8 buttons).
    expect(screen.getByRole("navigation", { name: "Milestone navigation" })).toHaveClass("min-w-24")
    expect(screen.getByRole("group", { name: "Move between chapters" })).toHaveClass("min-w-24")
    expect(screen.getByText("Matthew 1")).toHaveClass("truncate")
    expect(screen.getByText("Verses 1–25")).toHaveClass("truncate")
    expect(screen.getByText("Verses 1–25")).toHaveClass("hidden")
    expect(screen.getByText("Verses 1–25")).toHaveClass("xl:inline")
    expect(screen.getByRole("button", { name: "Previous chapter" })).toBeDisabled()
  })

  it("shows the full book name and restores fixed width from xl up", () => {
    const longNameChapters: MilestoneNavigationItem[] = [
      {
        key: "scripture:REV:20",
        kind: "chapter",
        label: "Revelation 20",
        shortLabel: "20",
        description: "Verses 1–15",
        translated: 0,
        validated: 0,
        total: 15,
      },
    ]
    render(<MilestoneNavigator items={longNameChapters} activeKey="scripture:REV:20" onSelect={() => {}} />)
    const trigger = screen.getByRole("combobox", { name: /Current chapter: Revelation 20/ })
    expect(trigger).toHaveClass("min-w-8")
    expect(trigger).toHaveClass("xl:w-56")
    expect(trigger).toHaveTextContent("Revelation 20")
    expect(screen.getByText("Revelation 20")).toHaveClass("truncate")
  })

  it("moves to the next chapter by stable milestone key", () => {
    const onSelect = vi.fn()
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }))
    expect(onSelect).toHaveBeenCalledWith("scripture:MAT:2")
  })

  it("opens an anchored searchable picker and selects a chapter", () => {
    const onSelect = vi.fn()
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={onSelect} />)
    openPicker(/Current chapter: Matthew 1/)
    expect(pickerSearch()).toBeInTheDocument()
    expect(pickerSearch().closest("[data-slot=input-group]")?.querySelector("svg.lucide-search")).toBeTruthy()
    expect(screen.getByText("32% validated")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: /Matthew 2 / }))
    expect(onSelect).toHaveBeenCalledWith("scripture:MAT:2")
  })

  it("marks the active milestone row as checked", () => {
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:2" onSelect={() => {}} />)
    openPicker(/Current chapter: Matthew 2/)
    expect(screen.getByRole("option", { name: /Matthew 2 / })).toHaveAttribute("data-checked", "true")
    expect(screen.getByRole("option", { name: /Matthew 3 / })).not.toHaveAttribute("data-checked")
  })

  it.each(["13", "31"])("matches complete compact chapter label %s instead of a fuzzy digit sequence", (chapterNumber) => {
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={() => {}} />)
    openPicker(/Current chapter: Matthew 1/)
    fireEvent.change(pickerSearch(), { target: { value: chapterNumber } })

    expect(screen.getByRole("option", { name: new RegExp(`Matthew ${chapterNumber} `) })).toBeInTheDocument()
    for (const otherChapter of ["3", "13", "31"].filter((value) => value !== chapterNumber)) {
      expect(screen.queryByRole("option", { name: new RegExp(`Matthew ${otherChapter} `) })).not.toBeInTheDocument()
    }
  })

  it("shows no result when an exact numeric chapter does not exist", () => {
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={() => {}} />)
    openPicker(/Current chapter: Matthew 1/)
    fireEvent.change(pickerSearch(), { target: { value: "30" } })

    expect(screen.getByText("No chapters found.")).toBeInTheDocument()
  })

  it("uses file-type-aware wording for non-Scripture milestones", () => {
    const slides: MilestoneNavigationItem[] = [
      { key: "slide:1", kind: "slide", label: "Welcome", shortLabel: "1", description: "4 cells", translated: 0, validated: 0, total: 4 },
      { key: "slide:2", kind: "slide", label: "Next steps", shortLabel: "2", description: "2 cells", translated: 1, validated: 0, total: 2 },
    ]
    render(<MilestoneNavigator items={slides} activeKey="slide:1" onSelect={() => {}} />)

    expect(screen.getByRole("combobox", { name: /Current slide: Welcome/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next slide" })).toBeEnabled()
    openPicker(/Current slide: Welcome/)
    expect(screen.queryByRole("heading", { name: "Go to slide" })).not.toBeInTheDocument()
    expect(pickerSearch("slide")).toBeInTheDocument()
    expect(pickerSearch("slide")).toHaveAttribute("placeholder", "Find a slide…")
    expect(screen.getByRole("group", { name: "Slides" })).toBeInTheDocument()
  })

  it("shows and navigates IDML subsection ranges like Codex Editor", () => {
    const onSelect = vi.fn()
    render(
      <MilestoneNavigator
        items={stories}
        activeKey="story:u363"
        activeSubsectionKey="story:u363:range:c52"
        onSelect={onSelect}
      />,
    )

    expect(screen.getByRole("combobox", { name: /Current story: Story u363, cells 51–100/ }))
      .toHaveTextContent("(51–100)")
    fireEvent.click(screen.getByRole("button", { name: "Previous story" }))
    expect(onSelect).toHaveBeenCalledWith("story:u363", "story:u363:range:c2")

    openPicker(/Current story: Story u363/)
    expect(screen.getByRole("option", { name: /Cells 1–50 100% translated 10% validated/ }))
      .toBeInTheDocument()
    const subsection = screen.getByRole("option", {
      name: /Cells 51–100 10% translated 0% validated/,
    })
    expect(subsection).toHaveAttribute("data-checked", "true")
    expect(subsection).toHaveAttribute("data-milestone-subsection")
    expect(subsection).toHaveClass("pl-6")
    fireEvent.click(screen.getByText("Cells 101–117"))
    expect(onSelect).toHaveBeenCalledWith("story:u363", "story:u363:range:c102")
  })

  it("expands a split milestone in place instead of navigating to it", () => {
    const onSelect = vi.fn()
    render(
      <MilestoneNavigator
        items={stories}
        activeKey="story:u363"
        activeSubsectionKey="story:u363:range:c2"
        onSelect={onSelect}
      />,
    )
    openPicker(/Current story: Story u363/)

    // Only the active story's ranges are listed until another one is opened.
    expect(screen.queryByRole("option", { name: /Cells 1–1 / })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("option", { name: /Story u44d21 / }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(pickerSearch("story")).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /Cells 1–1 / })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Cells 51–100 / })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("option", { name: /Cells 1–1 / }))
    expect(onSelect).toHaveBeenCalledWith("story:u44d21", "story:u44d21:range:c1")
  })

  it("shows the book-qualified label once without a numeric badge", () => {
    const ranges: MilestoneNavigationItem[] = [{
      key: "biblica:ISA:2-5",
      kind: "chapter-range",
      label: "Isaiah 2–5",
      shortLabel: "2–5",
      description: "16 cells",
      translated: 0,
      validated: 0,
      total: 16,
      subsections: [
        { key: "biblica:ISA:2-5:1-16", label: "1–16", firstCellId: "c1", translated: 0, validated: 0, total: 16 },
      ],
    }]

    render(<MilestoneNavigator items={ranges} activeKey="biblica:ISA:2-5" onSelect={() => {}} />)
    openPicker(/Current chapter: Isaiah 2–5/)

    expect(screen.queryByText("Go to chapter")).not.toBeInTheDocument()
    expect(screen.queryByText(/Choose a chapter or passage range/)).not.toBeInTheDocument()
    const parent = screen.getByRole("option", { name: /Isaiah 2–5 16 cells/ })
    expect(parent.querySelector("[data-milestone-badge]")).toBeNull()
    expect(parent.textContent?.match(/2–5/g)).toHaveLength(1)
    expect(screen.getByRole("option", { name: /Cells 1–16 0% translated 0% validated/ }))
      .toBeInTheDocument()
  })

  it("keeps duplicate labels independently selectable by stable key", () => {
    const sections: MilestoneNavigationItem[] = [
      { key: "heading:first", kind: "section", label: "Overview", shortLabel: "1", description: "3 cells", translated: 0, validated: 0, total: 3 },
      { key: "heading:second", kind: "section", label: "Overview", shortLabel: "2", description: "4 cells", translated: 0, validated: 0, total: 4 },
    ]
    const onSelect = vi.fn()
    render(<MilestoneNavigator items={sections} activeKey="heading:first" onSelect={onSelect} />)
    openPicker(/Current section: Overview/)
    fireEvent.click(screen.getAllByRole("option", { name: /Overview/ })[1])
    expect(onSelect).toHaveBeenCalledWith("heading:second")
  })

  it("virtualizes a whole-Bible chapter list instead of mounting every option", () => {
    const manyChapters: MilestoneNavigationItem[] = Array.from({ length: 1189 }, (_, index) => {
      const n = index + 1
      return {
        key: `scripture:GEN:${n}`,
        kind: "chapter" as const,
        label: `Genesis ${n}`,
        shortLabel: `${n}`,
        description: "Verses 1–1",
        translated: 0,
        validated: 0,
        total: 1,
      }
    })
    render(<MilestoneNavigator items={manyChapters} activeKey="scripture:GEN:1" onSelect={() => {}} />)
    openPicker(/Current chapter: Genesis 1/)

    const options = screen.getAllByRole("option")
    expect(options.length).toBeGreaterThan(0)
    expect(options.length).toBeLessThan(manyChapters.length)
    expect(screen.getByRole("option", { name: /Genesis 1 / })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Genesis 1189 / })).not.toBeInTheDocument()
  })

  it("keeps Combobox keyboard navigation: ArrowDown then Enter selects the next chapter", () => {
    const onSelect = vi.fn()
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={onSelect} />)
    openPicker(/Current chapter: Matthew 1/)

    const search = pickerSearch()
    fireEvent.focus(search)
    fireEvent.keyDown(search, { key: "ArrowDown" })
    fireEvent.keyDown(search, { key: "Enter" })

    expect(onSelect).toHaveBeenCalledWith("scripture:MAT:2")
  })

  it("keeps Combobox keyboard navigation after filtering", () => {
    const onSelect = vi.fn()
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={onSelect} />)
    openPicker(/Current chapter: Matthew 1/)

    const search = pickerSearch()
    fireEvent.change(search, { target: { value: "13" } })
    expect(screen.getByRole("option", { name: /Matthew 13 / })).toHaveAttribute("data-highlighted")
    fireEvent.focus(search)
    fireEvent.keyDown(search, { key: "Enter" })

    expect(onSelect).toHaveBeenCalledWith("scripture:MAT:13")
  })

  it("selects a far chapter via filter autoHighlight and Enter", () => {
    const onSelect = vi.fn()
    const manyChapters: MilestoneNavigationItem[] = Array.from({ length: 80 }, (_, index) => {
      const n = index + 1
      return {
        key: `scripture:PSA:${n}`,
        kind: "chapter" as const,
        label: `Psalm ${n}`,
        shortLabel: `${n}`,
        description: "Verses 1–1",
        translated: 0,
        validated: 0,
        total: 1,
      }
    })
    render(<MilestoneNavigator items={manyChapters} activeKey="scripture:PSA:1" onSelect={onSelect} />)
    openPicker(/Current chapter: Psalm 1/)

    const search = pickerSearch()
    fireEvent.change(search, { target: { value: "31" } })
    expect(screen.getByRole("option", { name: /Psalm 31 / })).toHaveAttribute("data-highlighted")
    fireEvent.focus(search)
    fireEvent.keyDown(search, { key: "Enter" })

    expect(onSelect).toHaveBeenCalledWith("scripture:PSA:31")
  })
})
