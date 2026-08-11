import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimelineCard } from "./TimelineCard"
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
})
