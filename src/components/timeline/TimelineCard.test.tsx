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

  it("emits moved bounds after dragging the body", () => {
    const onRetime = vi.fn()
    render(<TimelineCard cell={cell()} {...base} selected onSelect={() => {}} onRetime={onRetime} />)
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 }) // +40px = +1s
    fireEvent.pointerUp(window, { clientX: 140 })
    expect(onRetime).toHaveBeenCalledWith("c1", 2, 4)
  })

  it("does not retime when not editable", () => {
    const onRetime = vi.fn()
    render(
      <TimelineCard cell={cell()} {...base} editable={false} onSelect={() => {}} onRetime={onRetime} />,
    )
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 })
    fireEvent.pointerUp(window, { clientX: 140 })
    expect(onRetime).not.toHaveBeenCalled()
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
