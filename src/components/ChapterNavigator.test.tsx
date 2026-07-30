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

describe("MilestoneNavigator", () => {
  it("keeps the current chapter appearance and verse range visible", () => {
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={() => {}} />)
    expect(screen.getByRole("button", { name: /Current chapter: Matthew 1/ })).toHaveTextContent("Verses 1–25")
    expect(screen.getByText("Verses 1–25")).toHaveClass("justify-self-center")
    expect(screen.getByRole("button", { name: "Previous chapter" })).toBeDisabled()
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
    fireEvent.click(screen.getByRole("button", { name: /Current chapter: Matthew 1/ }))
    expect(screen.getByRole("combobox", { name: "Find a chapter" })).toBeInTheDocument()
    expect(screen.getByText("32% validated")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Matthew 2"))
    expect(onSelect).toHaveBeenCalledWith("scripture:MAT:2")
  })

  it.each(["13", "31"])("matches complete compact chapter label %s instead of a fuzzy digit sequence", (chapterNumber) => {
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /Current chapter: Matthew 1/ }))
    fireEvent.change(screen.getByRole("combobox", { name: "Find a chapter" }), {
      target: { value: chapterNumber },
    })

    expect(screen.getByRole("option", { name: new RegExp(`Matthew ${chapterNumber} `) })).toBeInTheDocument()
    for (const otherChapter of ["3", "13", "31"].filter((value) => value !== chapterNumber)) {
      expect(screen.queryByRole("option", { name: new RegExp(`Matthew ${otherChapter} `) })).not.toBeInTheDocument()
    }
  })

  it("uses file-type-aware wording for non-Scripture milestones", () => {
    const slides: MilestoneNavigationItem[] = [
      { key: "slide:1", kind: "slide", label: "Welcome", shortLabel: "1", description: "4 cells", translated: 0, validated: 0, total: 4 },
      { key: "slide:2", kind: "slide", label: "Next steps", shortLabel: "2", description: "2 cells", translated: 1, validated: 0, total: 2 },
    ]
    render(<MilestoneNavigator items={slides} activeKey="slide:1" onSelect={() => {}} />)

    expect(screen.getByRole("button", { name: /Current slide: Welcome/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next slide" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: /Current slide: Welcome/ }))
    expect(screen.getByRole("heading", { name: "Go to slide" })).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Slides" })).toBeInTheDocument()
  })

  it("shows and navigates IDML subsection ranges like Codex Editor", () => {
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
    const onSelect = vi.fn()
    render(
      <MilestoneNavigator
        items={stories}
        activeKey="story:u363"
        activeSubsectionKey="story:u363:range:c52"
        onSelect={onSelect}
      />,
    )

    expect(screen.getByRole("button", { name: /Current story: Story u363, cells 51–100/ }))
      .toHaveTextContent("(51–100)")
    fireEvent.click(screen.getByRole("button", { name: "Previous story" }))
    expect(onSelect).toHaveBeenCalledWith("story:u363", "story:u363:range:c2")

    fireEvent.click(screen.getByRole("button", { name: /Current story: Story u363/ }))
    expect(screen.getByRole("option", { name: /1–50 100% translated 10% validated/ }))
      .toBeInTheDocument()
    expect(screen.getByRole("option", { name: /51–100 10% translated 0% validated/ }))
      .toHaveAttribute("data-checked", "true")
    fireEvent.click(screen.getByText("101–117"))
    expect(onSelect).toHaveBeenCalledWith("story:u363", "story:u363:range:c102")
  })

  it("keeps duplicate labels independently selectable by stable key", () => {
    const sections: MilestoneNavigationItem[] = [
      { key: "heading:first", kind: "section", label: "Overview", shortLabel: "1", description: "3 cells", translated: 0, validated: 0, total: 3 },
      { key: "heading:second", kind: "section", label: "Overview", shortLabel: "2", description: "4 cells", translated: 0, validated: 0, total: 4 },
    ]
    const onSelect = vi.fn()
    render(<MilestoneNavigator items={sections} activeKey="heading:first" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button", { name: /Current section: Overview/ }))
    fireEvent.click(screen.getAllByRole("option", { name: /Overview/ })[1])
    expect(onSelect).toHaveBeenCalledWith("heading:second")
  })

  it("shows no result when an exact numeric chapter does not exist", () => {
    render(<MilestoneNavigator items={chapters} activeKey="scripture:MAT:1" onSelect={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /Current chapter: Matthew 1/ }))
    fireEvent.change(screen.getByRole("combobox", { name: "Find a chapter" }), {
      target: { value: "30" },
    })

    expect(screen.getByText("No chapters found.")).toBeInTheDocument()
  })
})
