import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ParallelBiblesSidebar } from "./ParallelBiblesSidebar"

vi.mock("@/lib/parsers/helloao", () => ({
  fetchHelloaoTranslations: vi.fn().mockResolvedValue([]),
  fetchHelloaoChapter: vi.fn().mockResolvedValue({
    chapter: { content: [] },
  }),
  flattenHelloaoContent: vi.fn(),
}))

describe("ParallelBiblesSidebar missing references", () => {
  beforeEach(() => localStorage.clear())

  it.each([null, "GEN"])(
    "explains missing references for %s, even with pinned versions",
    (trackedRef) => {
      localStorage.setItem(
        "aquilla:parallel-bibles:versions", JSON.stringify(["BSB"]),
      )
      render(
        <ParallelBiblesSidebar
          trackedRef={trackedRef} open onToggle={() => {}}
        />,
      )
      expect(screen.getByText("No Bible references")).toBeInTheDocument()
      expect(screen.getByText(
        "The current cells have no Bible references with chapter and verse " +
        "numbers. Parallel Bibles needs these references to show matching text.",
      )).toBeInTheDocument()
      expect(screen.queryByText(/Scroll the editor/)).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Add version" }))
      expect(screen.getByRole("textbox", {
        name: "Search Bible versions",
      })).toBeInTheDocument()
    },
  )

  it("replaces the empty state when a Bible reference becomes available", () => {
    const { rerender } = render(
      <ParallelBiblesSidebar trackedRef="GEN" open onToggle={() => {}} />,
    )
    rerender(
      <ParallelBiblesSidebar trackedRef="GEN 1:1" open onToggle={() => {}} />,
    )
    expect(screen.queryByText("No Bible references")).not.toBeInTheDocument()
    expect(screen.getByText("GEN 1:1")).toBeInTheDocument()
    expect(screen.getByText(
      "No versions added yet. Add a bible version to read alongside your text.",
    )).toBeInTheDocument()
  })
})
