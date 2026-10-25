import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { BookHealthSpine, type BookHealthChapter } from "./BookHealthSpine"

const chapters: BookHealthChapter[] = [
  {
    key: "chapter-1",
    label: "Mark 1",
    translated: 2,
    validated: 2,
    total: 2,
    cells: [
      { id: "1", stage: "validated", health: 100 },
      { id: "2", stage: "validated", health: 100 },
    ],
  },
  {
    key: "chapter-2",
    label: "Mark 2",
    translated: 2,
    validated: 1,
    total: 3,
    cells: [
      { id: "3", stage: "validated", health: 100 },
      { id: "4", stage: "automatic", health: 20, hasIssue: true },
      { id: "5", stage: "untranslated" },
    ],
  },
]

describe("BookHealthSpine", () => {
  it("renders clear chapter rows and cell structure without decorative timeline dots", () => {
    render(<BookHealthSpine chapters={chapters} onChapterClick={vi.fn()} />)

    expect(screen.getAllByTestId("book-health-chapter")).toHaveLength(2)
    expect(screen.queryByTestId("book-health-node")).not.toBeInTheDocument()
    expect(screen.queryByTestId("book-health-connector")).not.toBeInTheDocument()
    expect(screen.getAllByTestId("book-health-cell")).toHaveLength(5)
    expect(screen.getAllByTestId("book-health-matrix")[1]).toHaveStyle({
      gridTemplateColumns: "repeat(3, 7px)",
    })

    const chapterRows = screen.getAllByTestId("book-health-chapter")
    expect(chapterRows[0]).toHaveAttribute("data-health-score", "100")
    expect(chapterRows[1]).toHaveAttribute("data-health-score", "20")
    expect(screen.getAllByText("1/3")).toHaveLength(1)
    expect(screen.getAllByText("2/2")).toHaveLength(1)

  })

  it("paints progress squares in the shared progress palette and draws AI drafts as stripes (AQU-1764 / AQU-2159)", () => {
    render(
      <BookHealthSpine
        chapters={[{
          key: "chapter-4",
          label: "Mark 4",
          translated: 3,
          validated: 1,
          total: 5,
          cells: [
            { id: "v", stage: "validated", health: 100 },
            { id: "t", stage: "automatic", aiDrafted: true },
            { id: "s", stage: "automatic", health: 20, hasIssue: true, aiDrafted: true },
            { id: "u", stage: "untranslated" },
            { id: "x", stage: "excluded" },
          ],
        }]}
        onChapterClick={vi.fn()}
      />,
    )
    const [validated, drafted, scored, untranslated, excluded] = screen.getAllByTestId("book-health-cell")

    expect(validated.style.backgroundColor).toBe("var(--progress-text-validated)")
    // AQU-2159: a draft nobody has validated is the shared AI stripes — a
    // background-image utility, so no inline fill at all — and a LOW SCORE
    // CHANGES NOTHING. The pink tint a score used to give it was mistaken for
    // the magenta of a recorded take.
    for (const draft of [drafted, scored]) {
      expect(draft).toHaveAttribute("data-ai-draft", "true")
      expect(draft.className).toContain("bg-progress-ai")
      expect(draft.style.backgroundColor).toBe("")
    }
    // The untranslated slate and the hollow excluded heading are unchanged,
    // and neither is striped.
    expect(untranslated.style.backgroundColor).toBe("rgb(148 163 184 / 0.2)")
    expect(excluded.style.backgroundColor).toBe("transparent")
    expect(untranslated).not.toHaveAttribute("data-ai-draft")
    expect(excluded).not.toHaveAttribute("data-ai-draft")
  })

  it("rings a flagged line only when it has text (AQU-2159)", () => {
    render(
      <BookHealthSpine
        chapters={[{
          key: "chapter-5",
          label: "Mark 5",
          translated: 1,
          validated: 0,
          total: 3,
          cells: [
            { id: "d", stage: "automatic", health: 20, hasIssue: true },
            { id: "u", stage: "untranslated", hasIssue: true },
            { id: "x", stage: "excluded", hasIssue: true },
          ],
        }]}
        onChapterClick={vi.fn()}
      />,
    )
    const [drafted, untranslated, excluded] = screen.getAllByTestId("book-health-cell")

    expect(drafted.className).toContain("ring-amber-500")
    expect(drafted).toHaveAccessibleName(/automatic warning/)
    // An infraction on a line with nothing in it drew an amber ring around an
    // empty square, which reads as "this blank is wrong". Same for a heading
    // that is not being scored at all. The chapter's "N automatic warnings"
    // line still counts them.
    expect(untranslated.className).not.toContain("ring-amber-500")
    expect(excluded.className).not.toContain("ring-amber-500")
    expect(untranslated).toHaveAccessibleName("Cell 2: untranslated")
    expect(excluded).toHaveAccessibleName("Cell 3: heading — not counted toward progress")
  })

  it("keeps the quality score out of a square's label (AQU-2159)", () => {
    render(
      <BookHealthSpine
        chapters={[{
          key: "chapter-6",
          label: "Mark 6",
          translated: 1,
          validated: 0,
          total: 1,
          cells: [{ id: "d", stage: "automatic", health: 20 }],
        }]}
        onChapterClick={vi.fn()}
      />,
    )
    expect(screen.getByTestId("book-health-cell")).toHaveAccessibleName("Cell 1: translated, not validated yet")
  })

  it("stripes only an AI draft: a line a person typed stays the translated blue (AQU-2164)", () => {
    render(
      <BookHealthSpine
        chapters={[{
          key: "ruth-1",
          label: "Ruth 1",
          translated: 3,
          validated: 1,
          total: 3,
          cells: [
            { id: "low", stage: "automatic", health: 12, aiDrafted: true },
            { id: "unscored", stage: "automatic", aiDrafted: true },
            { id: "typed", stage: "automatic", health: 12 },
          ],
        }]}
        onChapterClick={vi.fn()}
      />,
    )
    const [low, unscored, typed] = screen.getAllByTestId("book-health-cell")
    for (const square of [low, unscored]) {
      expect(square).toHaveClass("bg-progress-ai")
      expect(square).toHaveAttribute("data-ai-draft", "true")
      // No inline fill at all, so nothing red sits over the stripes.
      expect(square.style.backgroundColor).toBe("")
      expect(square).toHaveAccessibleName(/AI draft, not validated yet/)
    }
    expect(typed).not.toHaveClass("bg-progress-ai")
    expect(typed.style.backgroundColor).toBe("var(--progress-text-translated)")
    expect(typed).toHaveAccessibleName("Cell 3: translated, not validated yet")
  })

  it("navigates by chapter label", () => {
    const onChapterClick = vi.fn()
    render(<BookHealthSpine chapters={chapters} onChapterClick={onChapterClick} />)

    fireEvent.click(screen.getByRole("button", { name: /Mark 2/ }))
    expect(onChapterClick).toHaveBeenCalledWith("Mark 2")
  })

  it("labels server-only summaries as percentages rather than fake counts", () => {
    render(
      <BookHealthSpine
        chapters={[{
          key: "chapter-3",
          label: "Mark 3",
          translated: 60,
          validated: 40,
          total: 100,
          percentagesOnly: true,
        }]}
        onChapterClick={vi.fn()}
      />,
    )

    expect(screen.getByText("40%")).toBeInTheDocument()
    expect(screen.getByText("60% translated")).toBeInTheDocument()
  })

  it("caps long chapters at a 10×10 matrix and expands on demand", () => {
    const cells = Array.from({ length: 105 }, (_, index) => ({
      id: `cell-${index}`,
      stage: index % 3 === 0 ? "validated" as const : "automatic" as const,
      health: index % 3 === 0 ? 100 : 35,
    }))
    render(
      <BookHealthSpine
        chapters={[{
          key: "long",
          label: "Psalm 119",
          translated: 105,
          validated: 35,
          total: 105,
          cells,
        }]}
        onChapterClick={vi.fn()}
      />,
    )

    expect(screen.getAllByTestId("book-health-cell")).toHaveLength(100)
    expect(screen.getByTestId("book-health-matrix")).toHaveStyle({
      gridTemplateColumns: "repeat(10, 7px)",
    })

    fireEvent.click(screen.getByRole("button", { name: "Show 5 more cells" }))
    expect(screen.getAllByTestId("book-health-cell")).toHaveLength(105)
    expect(screen.getByRole("button", { name: "Show fewer cells" })).toHaveAttribute("aria-expanded", "true")

    fireEvent.click(screen.getByRole("button", { name: "Show fewer cells" }))
    expect(screen.getAllByTestId("book-health-cell")).toHaveLength(100)
  })
})
