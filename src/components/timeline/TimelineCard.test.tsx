import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimelineCard } from "./TimelineCard"
import { chipRadiusPx } from "@/lib/timeline/scale"
import type { CellData } from "@/hooks/useCells"

const cell = (o: Partial<CellData> = {}): CellData =>
  ({
    id: "c1",
    fileId: "f1",
    original: "Go get the man",
    translated: "",
    startTime: 1,
    endTime: 3,
    medium: "media",
    ...o,
  }) as unknown as CellData

const base = {
  pxPerSec: 40,
  laneStartSec: 0,
  variant: "dialogue" as const,
  selected: false,
  editable: true,
  // Round 6: retiming is a LANE property; drag tests use the subtitle lane
  // (the source row is frozen — covered by its own tests below).
  retimable: true,
}

describe("TimelineCard", () => {
  it("positions by time (left/width in px)", () => {
    render(<TimelineCard cell={cell()} {...base} onSelect={() => {}} onRetime={() => {}} />)
    const el = screen.getByTestId("tl-card-c1")
    expect(el).toHaveStyle({ left: "40px", width: "80px" }) // 1s*40, (3-1)s*40
  })

  it("selects on click", () => {
    const onSelect = vi.fn()
    render(<TimelineCard cell={cell()} {...base} onSelect={onSelect} onRetime={() => {}} />)
    fireEvent.click(screen.getByTestId("tl-card-c1"))
    expect(onSelect).toHaveBeenCalledWith("c1")
  })

  it("emits moved bounds after dragging the body (subtitle lane)", () => {
    const onRetime = vi.fn()
    render(<TimelineCard cell={cell()} {...base} variant="subtitle" selected onSelect={() => {}} onRetime={onRetime} />)
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 }) // +40px = +1s
    fireEvent.pointerUp(window, { clientX: 140 })
    expect(onRetime).toHaveBeenCalledWith("c1", 2, 4)
  })

  // ── SUB-11: live millisecond readout while dragging ───────────────────────

  it("shows a live drag chip with the exact times release would commit", () => {
    render(<TimelineCard cell={cell()} {...base} onSelect={() => {}} onRetime={() => {}} />)
    const el = screen.getByTestId("tl-card-c1")

    // No chip at rest.
    expect(screen.queryByTestId("tl-drag-chip")).not.toBeInTheDocument()

    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 }) // +40px = +1s → 2s–4s
    const chip = screen.getByTestId("tl-drag-chip")
    // Move mode: both bounds with ms precision, plus the signed delta.
    expect(chip.textContent).toContain("00:02.000–00:04.000")
    expect(chip.textContent).toContain("+1.00s")

    fireEvent.pointerUp(window, { clientX: 140 })
    expect(screen.queryByTestId("tl-drag-chip")).not.toBeInTheDocument()
  })

  it("chip tracks the dragged edge on resize and respects the min-duration clamp", () => {
    render(<TimelineCard cell={cell()} {...base} onSelect={() => {}} onRetime={() => {}} />)
    // Grab the right-edge grip: the second grip span (aria-hidden handles).
    const el = screen.getByTestId("tl-card-c1")
    const grips = el.querySelectorAll("span.cursor-ew-resize")
    fireEvent.pointerDown(grips[1] as Element, { clientX: 200, pointerId: 2 })
    fireEvent.pointerMove(window, { clientX: 180 }) // −20px = −0.5s → end 2.5s
    const chip = screen.getByTestId("tl-drag-chip")
    expect(chip.textContent).toContain("00:02.500")
    expect(chip.textContent).toContain("−0.50s")
    fireEvent.pointerUp(window, { clientX: 180 })
  })

  it("does not retime when not editable", () => {
    const onRetime = vi.fn()
    render(
      <TimelineCard cell={cell()} {...base} variant="subtitle" editable={false} onSelect={() => {}} onRetime={onRetime} />,
    )
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 })
    fireEvent.pointerUp(window, { clientX: 140 })
    expect(onRetime).not.toHaveBeenCalled()
  })

  // ── Round 6 (SUB-36): the source row is frozen; subtitles own their span ──

  it("a non-retimable (source-row) card ignores drags and shows no grips", () => {
    const onRetime = vi.fn()
    const { container } = render(
      <TimelineCard cell={cell()} {...base} retimable={false} onSelect={() => {}} onRetime={onRetime} />,
    )
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 })
    fireEvent.pointerUp(window, { clientX: 140 })
    expect(onRetime).not.toHaveBeenCalled()
    expect(container.querySelector(".cursor-ew-resize")).toBeNull()
  })

  it("a subtitle card on a media cell renders its INDEPENDENT span from metadata", () => {
    render(
      <TimelineCard
        cell={cell({ metadata: { subtitle_start_ms: 2000, subtitle_end_ms: 5000 } })}
        {...base}
        variant="subtitle"
        onSelect={() => {}}
        onRetime={() => {}}
      />,
    )
    expect(screen.getByTestId("tl-card-c1")).toHaveStyle({ left: "80px", width: "120px" }) // 2s*40, 3s*40
  })

  it("the dialogue card IGNORES subtitle metadata — it always shows the frozen source split", () => {
    render(
      <TimelineCard
        cell={cell({ metadata: { subtitle_start_ms: 2000, subtitle_end_ms: 5000 } })}
        {...base}
        retimable={false}
        onSelect={() => {}}
        onRetime={() => {}}
      />,
    )
    expect(screen.getByTestId("tl-card-c1")).toHaveStyle({ left: "40px", width: "80px" }) // 1s*40, 2s*40
  })

  it("snap: a drag ending near a candidate edge commits flush to it", () => {
    const onRetime = vi.fn()
    render(
      <TimelineCard
        cell={cell()}
        {...base}
        variant="subtitle"
        snap={{ enabled: true, candidates: [2.1] }}
        onSelect={() => {}}
        onRetime={onRetime}
      />,
    )
    const el = screen.getByTestId("tl-card-c1")
    // +40px = +1s → proposed start 2.0; candidate 2.1 is within 8px/40 = 0.2s.
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 })
    fireEvent.pointerUp(window, { clientX: 140 })
    expect(onRetime).toHaveBeenCalledTimes(1)
    const [, start, end] = onRetime.mock.calls[0] as [string, number, number]
    expect(start).toBeCloseTo(2.1)
    expect(end).toBeCloseTo(4.1)
  })

  it("snap disabled → the raw drag commits", () => {
    const onRetime = vi.fn()
    render(
      <TimelineCard
        cell={cell()}
        {...base}
        variant="subtitle"
        snap={{ enabled: false, candidates: [2.1] }}
        onSelect={() => {}}
        onRetime={onRetime}
      />,
    )
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 })
    fireEvent.pointerUp(window, { clientX: 140 })
    expect(onRetime).toHaveBeenCalledWith("c1", 2, 4)
  })

  // ── AQU-646: clean click seeks; a drag is a retime, not a seek ──

  it("fires onSeek on a clean click (alongside onSelect)", () => {
    const onSeek = vi.fn()
    const onSelect = vi.fn()
    render(<TimelineCard cell={cell()} {...base} onSelect={onSelect} onRetime={() => {}} onSeek={onSeek} />)
    fireEvent.click(screen.getByTestId("tl-card-c1"))
    expect(onSeek).toHaveBeenCalledWith("c1")
    expect(onSelect).toHaveBeenCalledWith("c1")
  })

  it("suppresses onSeek after a drag (>3px), while the retime still commits", () => {
    const onSeek = vi.fn()
    const onRetime = vi.fn()
    render(<TimelineCard cell={cell()} {...base} onSelect={() => {}} onRetime={onRetime} onSeek={onSeek} />)
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 })
    fireEvent.pointerUp(window, { clientX: 140 })
    fireEvent.click(el) // browsers fire click after pointerup
    expect(onRetime).toHaveBeenCalledWith("c1", 2, 4)
    expect(onSeek).not.toHaveBeenCalled()
  })

  // ── AQU-646: subtitle-lane mirror card for a media cell ──

  it("subtitle-variant media cell shows translation over transcript (never the filename)", () => {
    const media = cell({ original: "episode.mp3", transcription: "hello there", translated: "" })
    const { rerender } = render(
      <TimelineCard cell={media} {...base} variant="subtitle" onSelect={() => {}} onRetime={() => {}} />,
    )
    expect(screen.getByTestId("tl-card-c1")).toHaveTextContent("hello there")
    rerender(
      <TimelineCard
        cell={cell({ original: "episode.mp3", transcription: "hello there", translated: "hola" })}
        {...base}
        variant="subtitle"
        onSelect={() => {}}
        onRetime={() => {}}
      />,
    )
    expect(screen.getByTestId("tl-card-c1")).toHaveTextContent("hola")
  })

  // ── AQU-646 round 8: neighbour walls ──
  //
  // A line added into a silence may move, but subtitle timing IS the cell's
  // timing — so unlike a dub take it never gets to be approximate. The card
  // stops dead at its neighbours' edges rather than crossing or overlapping.

  describe("bounds", () => {
    // The cell is 1s–3s at 40px/s. Walls at 0.5s and 4s leave 0.5s of slack
    // either way.
    const bounded = { minStartSec: 0.5, maxEndSec: 4 }

    const dragBody = (dxPx: number) => {
      const el = screen.getByTestId("tl-card-c1")
      fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 100 + dxPx })
      fireEvent.pointerUp(window, { clientX: 100 + dxPx })
    }

    it("a move stops at the far wall, keeping its length", () => {
      const onRetime = vi.fn()
      render(
        <TimelineCard cell={cell()} {...base} variant="subtitle" bounds={bounded}
          onSelect={() => {}} onRetime={onRetime} />,
      )
      dragBody(400) // +10s, far past the wall
      // Length preserved (2s), right edge flush with the neighbour.
      expect(onRetime).toHaveBeenCalledWith("c1", 2, 4)
    })

    it("a move stops at the near wall too", () => {
      const onRetime = vi.fn()
      render(
        <TimelineCard cell={cell()} {...base} variant="subtitle" bounds={bounded}
          onSelect={() => {}} onRetime={onRetime} />,
      )
      dragBody(-400)
      expect(onRetime).toHaveBeenCalledWith("c1", 0.5, 2.5)
    })

    it("stretching the end stops at the next cue's start", () => {
      const onRetime = vi.fn()
      render(
        <TimelineCard cell={cell()} {...base} variant="subtitle" bounds={bounded}
          onSelect={() => {}} onRetime={onRetime} />,
      )
      const grips = document.querySelectorAll(".cursor-ew-resize")
      fireEvent.pointerDown(grips[1] as Element, { clientX: 200, pointerId: 2 })
      fireEvent.pointerMove(window, { clientX: 600 })
      fireEvent.pointerUp(window, { clientX: 600 })
      expect(onRetime).toHaveBeenCalledWith("c1", 1, 4)
    })

    it("stretching the start stops at the previous cue's end", () => {
      const onRetime = vi.fn()
      render(
        <TimelineCard cell={cell()} {...base} variant="subtitle" bounds={bounded}
          onSelect={() => {}} onRetime={onRetime} />,
      )
      const grips = document.querySelectorAll(".cursor-ew-resize")
      fireEvent.pointerDown(grips[0] as Element, { clientX: 40, pointerId: 3 })
      fireEvent.pointerMove(window, { clientX: -400 })
      fireEvent.pointerUp(window, { clientX: -400 })
      expect(onRetime).toHaveBeenCalledWith("c1", 0.5, 3)
    })

    it("the wall beats a snap candidate that sits beyond it", () => {
      // 6s is a legal edge to snap to and an illegal place to land. Clamping
      // BEFORE snapping would let the snap step back over the wall; this is
      // the assertion that pins the order.
      const onRetime = vi.fn()
      render(
        <TimelineCard cell={cell()} {...base} variant="subtitle" bounds={bounded}
          snap={{ enabled: true, candidates: [6] }} onSelect={() => {}} onRetime={onRetime} />,
      )
      dragBody(200) // +5s → 6s–8s, right on the candidate
      expect(onRetime).toHaveBeenCalledWith("c1", 2, 4)
    })

    it("left out entirely, nothing is constrained", () => {
      const onRetime = vi.fn()
      render(
        <TimelineCard cell={cell()} {...base} variant="subtitle" onSelect={() => {}} onRetime={onRetime} />,
      )
      dragBody(400)
      expect(onRetime).toHaveBeenCalledWith("c1", 11, 13)
    })
  })

  // The box and the number came from two different computations before round 8
  // — one snapped and unclamped, the other clamped and unsnapped — so with
  // snapping on they could disagree about where release would land.
  it("with snapping on, the drawn box and the live readout agree", () => {
    render(
      <TimelineCard cell={cell()} {...base} variant="subtitle"
        snap={{ enabled: true, candidates: [5] }} onSelect={() => {}} onRetime={() => {}} />,
    )
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    // +3.9s lands at 4.9s — inside the snap threshold of the 5s candidate.
    fireEvent.pointerMove(window, { clientX: 256 })
    // The box snapped to 5s...
    expect(el).toHaveStyle({ left: "200px" })
    // ...so the readout must say 5s too, not the unsnapped 4.9s.
    expect(screen.getByTestId("tl-drag-chip").textContent).toContain("00:05.000")
    fireEvent.pointerUp(window, { clientX: 256 })
  })

  // ── AQU-646 round 9: a chip too narrow to read says nothing ──
  //
  // Fully zoomed out a chip is 10-20px wide and was still rendering its label
  // AND its clock range. Every chip became a column of one or two truncated
  // glyphs, and the clock strings read as if they bled across neighbours. Sam
  // called it "rendering issues in the source timeline".
  describe("text thresholds", () => {
    // The fixture cell is 1s-3s, so pxPerSec IS the card's width in px per 2s.
    const atWidth = (widthPx: number) =>
      render(
        <TimelineCard
          cell={cell()}
          {...base}
          pxPerSec={widthPx / 2}
          onSelect={() => {}}
          onRetime={() => {}}
          onRemove={() => {}}
        />,
      )

    it("a wide card says everything", () => {
      atWidth(200)
      const card = screen.getByTestId("tl-card-c1")
      expect(card).toHaveTextContent("Go get the man")
      expect(card.textContent).toContain("–")
      expect(screen.getByTestId("tl-card-c1-remove")).toBeInTheDocument()
    })

    it("below the meta threshold the CLOCK goes but the label stays", () => {
      // 60px: the label truncates gracefully, the clock string (~85px) would not.
      atWidth(60)
      const card = screen.getByTestId("tl-card-c1")
      expect(card).toHaveTextContent("Go get the man")
      expect(card.textContent).not.toContain("–")
    })

    it("below the text threshold the card is a plain block", () => {
      atWidth(20)
      const card = screen.getByTestId("tl-card-c1")
      expect(card.textContent).toBe("")
      // The X is 16px on a 20px card — it covered the whole chip.
      expect(screen.queryByTestId("tl-card-c1-remove")).toBeNull()
    })

    it("its corner sharpens as it narrows, and the accent bar follows", () => {
      // Asserts the WIRING, not the curve — scale.test.ts owns the maths, so a
      // future tweak to the ramp does not have to be re-typed here. The accent
      // bar is a separate absolutely-positioned span; with a fixed radius it
      // would poke out of a sharpened corner.
      const radii = (w: number) => {
        const { unmount } = atWidth(w)
        const card = screen.getByTestId("tl-card-c1")
        const bar = card.querySelector("span.absolute.inset-y-0.left-0") as HTMLElement
        const out = {
          card: parseFloat(card.style.borderRadius),
          barTop: parseFloat(bar.style.borderTopLeftRadius),
          barBottom: parseFloat(bar.style.borderBottomLeftRadius),
        }
        unmount()
        return out
      }

      const wide = radii(200)
      expect(wide.card).toBeCloseTo(chipRadiusPx(200), 3)
      expect(wide.card).toBe(8) // unchanged from the rounded-lg it replaced

      const narrow = radii(20)
      expect(narrow.card).toBeCloseTo(chipRadiusPx(20), 3)
      expect(narrow.card).toBeLessThan(wide.card)

      // The bar tracks the card in both states, or it overhangs the corner.
      expect(wide.barTop).toBe(wide.card)
      expect(wide.barBottom).toBe(wide.card)
      expect(narrow.barTop).toBe(narrow.card)
      expect(narrow.barBottom).toBe(narrow.card)
    })

    it("a card being DRAGGED keeps its text however narrow it is", () => {
      // You are looking straight at it, and the live readout is the point.
      atWidth(20)
      const card = screen.getByTestId("tl-card-c1")
      fireEvent.pointerDown(card, { clientX: 100, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 140 })
      expect(card).toHaveTextContent("Go get the man")
      fireEvent.pointerUp(window, { clientX: 140 })
    })
  })
})
