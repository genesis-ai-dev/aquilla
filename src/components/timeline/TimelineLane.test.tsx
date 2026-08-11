import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
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

  // AQU-646 round 8: an imported VTT cue is frozen while a line someone added
  // in the same lane still moves, so the veto has to be per CARD.
  describe("canRetimeCell", () => {
    const lane = (props: Partial<React.ComponentProps<typeof TimelineLane>> = {}) =>
      render(
        <TimelineLane
          cells={[cell("frozen", 0, 2), cell("free", 4, 6)]}
          variant="subtitle"
          pxPerSec={40}
          viewStartSec={0}
          viewEndSec={10}
          selectedId={null}
          editable
          retimable
          onSelect={() => {}}
          onRetime={() => {}}
          {...props}
        />,
      )

    const grips = (cardId: string) =>
      screen.getByTestId(`tl-card-${cardId}`).querySelectorAll(".cursor-ew-resize")

    it("freezes only the cards it refuses", () => {
      lane({ canRetimeCell: (c) => c.id !== "frozen" })
      expect(grips("frozen")).toHaveLength(0)
      expect(grips("free")).toHaveLength(2)
    })

    it("left out, every card still moves — no existing caller changes", () => {
      lane()
      expect(grips("frozen")).toHaveLength(2)
      expect(grips("free")).toHaveLength(2)
    })

    it("cannot thaw a lane the lane-wide flag already froze", () => {
      // SUB-53: a subtitle span on a re-flowed track has no draggable meaning.
      // A permissive predicate must not be able to override that.
      lane({ retimable: false, canRetimeCell: () => true })
      expect(grips("free")).toHaveLength(0)
    })
  })

  // AQU-646 round 8: a card may not cross its neighbours. The bounds come from
  // the WHOLE lane, which is the part that is easy to get wrong.
  describe("boundNeighbours", () => {
    const dragCard = (id: string, dxPx: number) => {
      const el = screen.getByTestId(`tl-card-${id}`)
      fireEvent.pointerDown(el, { clientX: 500, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 500 + dxPx })
      fireEvent.pointerUp(window, { clientX: 500 + dxPx })
    }

    it("a neighbour scrolled OFF-SCREEN still stops the drag", () => {
      // This is the whole point of deriving bounds before the window filter.
      // `next` sits at 8.5s, outside the [3,8] view, so a bounds computation
      // built on the visible list would leave `b` free to sail through it.
      const onRetime = vi.fn()
      render(
        <TimelineLane
          cells={[cell("b", 4, 6), cell("next", 8.5, 10)]}
          variant="subtitle"
          pxPerSec={40}
          viewStartSec={3}
          viewEndSec={8}
          selectedId={null}
          editable
          retimable
          boundNeighbours
          onSelect={() => {}}
          onRetime={onRetime}
        />,
      )
      expect(screen.queryByTestId("tl-card-next")).not.toBeInTheDocument()
      dragCard("b", 400) // +10s, way past it
      expect(onRetime).toHaveBeenCalledWith("b", 6.5, 8.5)
    })

    it("the floor is the highest end before it, not the previous card's end", () => {
      // `cells` is sorted by START, so with overlapping cues a long early cue
      // can reach past a shorter one that starts later. Taking the immediate
      // predecessor's end would let `target` slide back inside `long`.
      const onRetime = vi.fn()
      render(
        <TimelineLane
          cells={[cell("long", 0, 10), cell("short", 2, 3), cell("target", 11, 12)]}
          variant="subtitle"
          pxPerSec={40}
          viewStartSec={0}
          viewEndSec={20}
          selectedId={null}
          editable
          retimable
          boundNeighbours
          onSelect={() => {}}
          onRetime={onRetime}
        />,
      )
      dragCard("target", -400) // −10s
      expect(onRetime).toHaveBeenCalledWith("target", 10, 11)
    })

    it("left off, cards are free — SUB-36's mirror must stay that way", () => {
      const onRetime = vi.fn()
      render(
        <TimelineLane
          cells={[cell("b", 4, 6), cell("next", 8.5, 10)]}
          variant="subtitle"
          pxPerSec={40}
          viewStartSec={0}
          viewEndSec={40}
          selectedId={null}
          editable
          retimable
          onSelect={() => {}}
          onRetime={onRetime}
        />,
      )
      dragCard("b", 400)
      expect(onRetime).toHaveBeenCalledWith("b", 14, 16)
    })
  })
})
