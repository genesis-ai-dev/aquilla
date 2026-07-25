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

  // ── Round 6 (SUB-38): the source card's voice picker ──

  const voiceSettings = {
    voices: [
      { id: "v-narrator", name: "Narrator", color: "#111" },
      { id: "v-marta", name: "Marta", color: "#222" },
    ],
    defaultVoiceId: "v-narrator",
    castAssignments: {},
  }

  it("dialogue card shows the voice picker; picking assigns to THIS cell", () => {
    const onAssign = vi.fn()
    render(
      <TimelineCard
        cell={cell({ metadata: { cast_name: "Speaker 1" } })}
        {...base}
        retimable={false}
        onSelect={() => {}}
        onRetime={() => {}}
        voiceControl={{ settings: voiceSettings, onAssign }}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-voice-c1"))
    fireEvent.click(screen.getByText("Marta"))
    expect(onAssign).toHaveBeenCalledTimes(1)
    const [assignedCell, voiceId, opts] = onAssign.mock.calls[0] as [CellData, string, { applyToSpeaker?: boolean }]
    expect(assignedCell.id).toBe("c1")
    expect(voiceId).toBe("v-marta")
    expect(opts.applyToSpeaker).toBe(false)
  })

  it("the apply-to-all-speaker-lines toggle rides the assignment", () => {
    const onAssign = vi.fn()
    render(
      <TimelineCard
        cell={cell({ metadata: { cast_name: "Speaker 1" } })}
        {...base}
        retimable={false}
        onSelect={() => {}}
        onRetime={() => {}}
        voiceControl={{ settings: voiceSettings, onAssign }}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-voice-c1"))
    fireEvent.click(screen.getByTestId("tl-voice-all-c1"))
    fireEvent.click(screen.getByText("Marta"))
    const [, , opts] = onAssign.mock.calls[0] as [CellData, string, { applyToSpeaker?: boolean }]
    expect(opts.applyToSpeaker).toBe(true)
  })

  it("opening the picker never seeks or selects the card", () => {
    const onSeek = vi.fn()
    const onSelect = vi.fn()
    render(
      <TimelineCard
        cell={cell()}
        {...base}
        retimable={false}
        onSelect={onSelect}
        onRetime={() => {}}
        onSeek={onSeek}
        voiceControl={{ settings: voiceSettings, onAssign: () => {} }}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-voice-c1"))
    expect(onSeek).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("subtitle cards get no voice picker", () => {
    render(
      <TimelineCard
        cell={cell()}
        {...base}
        variant="subtitle"
        onSelect={() => {}}
        onRetime={() => {}}
        voiceControl={{ settings: voiceSettings, onAssign: () => {} }}
      />,
    )
    expect(screen.queryByTestId("tl-voice-c1")).toBeNull()
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
