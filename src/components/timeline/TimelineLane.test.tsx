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
        retimable={false}
        onSelect={() => {}}
        onRetime={() => {}}
      />,
    )
    const cards = screen.getAllByTestId(/^tl-card-/)
    expect(cards).toHaveLength(1)
    expect(screen.getByTestId("tl-card-b")).toBeInTheDocument()
  })

  // Round 6 (SUB-36): the subtitle lane windows by the EFFECTIVE span — a
  // media cell's independent subtitle span may live far from its section.
  it("windows subtitle-variant media cells by their independent span", () => {
    const moved = {
      ...cell("moved", 0, 2),
      metadata: { subtitle_start_ms: 4000, subtitle_end_ms: 6000 },
    } as CellData
    render(
      <TimelineLane
        cells={[moved]}
        variant="subtitle"
        pxPerSec={40}
        viewStartSec={3}
        viewEndSec={8}
        selectedId={null}
        editable
        retimable
        onSelect={() => {}}
        onRetime={() => {}}
      />,
    )
    // Section [0,2] is outside the [3,8] window, but the subtitle span [4,6]
    // is inside — the card must render (and at the subtitle position).
    expect(screen.getByTestId("tl-card-moved")).toHaveStyle({ left: "160px" })
  })
})
