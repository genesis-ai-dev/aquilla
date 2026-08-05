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
