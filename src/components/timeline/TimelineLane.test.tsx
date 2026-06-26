import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { TimelineLane } from "./TimelineLane"
import type { CellData } from "@/hooks/useCells"

const cell = (id: string, startTime: number, endTime: number): CellData =>
  ({ id, fileId: "f1", original: id, translated: "", startTime, endTime, medium: "media" }) as unknown as CellData

describe("TimelineLane", () => {
  it("renders only cards intersecting the visible window", () => {
    render(
      <TimelineLane
        cells={[cell("a", 0, 2), cell("far", 100, 102), cell("b", 4, 6)]}
        variant="dialogue"
        pxPerSec={40}
        viewStartSec={3}
        viewEndSec={8}
        selectedId={null}
        editable
        onSelect={() => {}}
        onRetime={() => {}}
      />,
    )
    const cards = screen.getAllByTestId(/^tl-card-/)
    expect(cards).toHaveLength(1)
    expect(screen.getByTestId("tl-card-b")).toBeInTheDocument()
  })
})
