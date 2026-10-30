// AQU-2235: the name bar on every timeline take (Sam, Oct 28, board 54 of the
// Media Redesign canvas): "We go with medium. We go with the bar name from the
// take. Double clicking to rename should work. Dragging to move should work."
//
//   14px on the 46px clips, 12px on 30–39px clips, none under 30px
//   the track hue at 34%; 10px text (9px in the small bar), 5px padding
//   left to right: sparkle · the take's name (a piece's) · the voice, lighter
//   right end: the approval check; on hover record and ⋯ in its place
//   it gives way from the right as the clip narrows

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { TargetAudioLane, type TakeMenuActions, type TargetAudioItem } from "./TargetAudioLane"
import { RowMetricsContext } from "./useRowMetrics"
import { chipHeightPx, chipPadPx, nameBarPx } from "@/lib/timeline/row-metrics"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
const TAKE = "audio-c1-1700000000-take.webm"

function cell(attachments: Record<string, unknown>, over: Partial<CellData> = {}): CellData {
  return {
    id: "c1", fileId: "f1", original: "", translated: "",
    medium: "media", startTime: 10, endTime: 20,
    selectedAudioId: TAKE,
    attachments: { ...attachments, [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" } },
    ...over,
  } as unknown as CellData
}
const take = (over: Record<string, unknown> = {}) =>
  ({ [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", label: "Take 2", durationMs: 8000, ...over } })
const item = (over: Record<string, unknown> = {}, kind: "take" | "generated" = "take"): TargetAudioItem =>
  ({ cell: cell(take(over)), kind, audioId: TAKE })

function menu(over: Partial<TakeMenuActions> = {}): TakeMenuActions {
  return { rename: vi.fn(), remove: vi.fn(), reRecord: vi.fn(), ...over }
}

const base = {
  validationRequirementAudio: 1,
  pxPerSec: 40,
  viewStartSec: 0,
  viewEndSec: 100,
  selectedId: null,
  editable: true,
  snapEnabled: false,
  onSelect: () => {},
}

/** Renders the lane at a row height, so the chip is `chipHeightPx(rowH)` tall. */
function atRow(rowH: number, ui: React.ReactElement) {
  const chipH = chipHeightPx(rowH)
  return render(
    <RowMetricsContext.Provider value={{ rowH, chipH, chipPad: chipPadPx(rowH) }}>{ui}</RowMetricsContext.Provider>,
  )
}
const bar = () => screen.queryByTestId("tl-target-c1-bar")

describe("the bar's height", () => {
  it("is 14px on the timeline's 46px clips", () => {
    render(<TargetAudioLane {...base} items={[item()]} />)
    expect(bar()).toHaveAttribute("data-bar-h", "14")
    expect(bar()!.style.height).toBe("14px")
    expect(bar()!.style.fontSize).toBe("10px")
  })

  it("is 12px on a 30–39px clip, with 9px text", () => {
    // A 50px row draws a 36px chip.
    expect(chipHeightPx(50)).toBeGreaterThanOrEqual(30)
    expect(chipHeightPx(50)).toBeLessThan(40)
    atRow(50, <TargetAudioLane {...base} items={[item()]} />)
    expect(bar()).toHaveAttribute("data-bar-h", "12")
    expect(bar()!.style.fontSize).toBe("9px")
  })

  it("goes under 30px, and today's corner marks come back", () => {
    expect(chipHeightPx(40)).toBeLessThan(30)
    atRow(40, <TargetAudioLane {...base} items={[item({ validatorCount: 1, validators: ["sam"] })]} session={{ jwt: "t", username: "sam" } as never} />)
    expect(bar()).toBeNull()
    // The corner tick, as it always was.
    expect(screen.getByTestId("tl-target-c1-validated").className).toContain("bottom-1")
  })

  it("follows the clip height exactly: 14 from 40px, 12 from 30px, none below", () => {
    expect([29, 30, 39, 40, 46, 140].map(nameBarPx)).toEqual([0, 12, 12, 14, 14, 14])
  })
})

describe("the bar's colour", () => {
  it("is the track's strip colour, matching the strip at its far left (Oct 28)", () => {
    render(<TargetAudioLane {...base} color="violet" items={[item()]} />)
    expect(bar()!.className).toContain("bg-[color:var(--tl-track-bar)]")
    // Sam, Oct 28: the track's strip colour, the same as the strip at its far left.
    // …at 90% opacity.
    expect(screen.getByTestId("tl-target-lane").style.getPropertyValue("--tl-track-bar")).toBe(
      "color-mix(in oklab, oklch(0.595 0.140 292.4) 90%, transparent)",
    )
    expect(screen.getByTestId("tl-target-lane").style.getPropertyValue("--tl-track-strip")).toBe("oklch(0.595 0.140 292.4)")
  })

  it("turns red with the chip at fault: a warning still beats the track colour", () => {
    const first = item({ durationMs: 12500 }) // [10, 22.5] — into the next chip
    const c2 = "audio-c2-1700000000-take.webm"
    const second: TargetAudioItem = {
      cell: { ...cell({ [c2]: { type: "audio", url: "frontier-audio://t2", durationMs: 4000 } }), id: "c2", startTime: 20, endTime: 30, selectedAudioId: c2 } as unknown as CellData,
      kind: "take",
      audioId: c2,
    }
    render(<TargetAudioLane {...base} items={[first, second]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "overlap")
    expect(bar()!.className).toContain("bg-red-500/20")
    expect(screen.getByTestId("tl-target-c2-bar").className).toContain("bg-[color:var(--tl-track-bar)]")
  })
})

describe("what the bar says", () => {
  it("names the TAKE, at weight 600, truncating", () => {
    render(<TargetAudioLane {...base} items={[item()]} />)
    const name = screen.getByTestId("tl-target-c1-name")
    expect(name).toHaveTextContent("Take 2")
    expect(name.className).toContain("font-semibold")
    expect(name.className).toContain("truncate")
  })

  it("says 'Take' for a take with no name yet", () => {
    render(<TargetAudioLane {...base} items={[item({ label: undefined })]} />)
    expect(screen.getByTestId("tl-target-c1-name")).toHaveTextContent("Take")
  })

  it("names a piece by its take and its place: 'Take 2 · 1 of 2'", () => {
    const PIECE = "audio-c1-1700000500-piece.webm"
    const c = cell({
      [TAKE]: { type: "audio", url: "frontier-audio://t", slot: "recording", label: "Take 2 · 1", durationMs: 8000, trimEndMs: 3000 },
      [PIECE]: { type: "audio", url: "frontier-audio://t", slot: "recording", label: "Take 2 · 2", pieceOf: TAKE, durationMs: 8000, trimStartMs: 3000 },
    })
    render(
      <TargetAudioLane
        {...base}
        items={[
          { cell: c, kind: "take", audioId: TAKE, pieceIndex: 0, pieceCount: 2 },
          { cell: c, kind: "take", audioId: PIECE, pieceIndex: 1, pieceCount: 2 },
        ]}
      />,
    )
    expect(screen.getByTestId("tl-target-c1-name")).toHaveTextContent("Take 2 · 1 of 2")
    expect(screen.getByTestId("tl-target-c1-p2-name")).toHaveTextContent("Take 2 · 2 of 2")
  })

  it("leads with the sparkle for an AI voice, then the name, then the voice when it isn't the line's", () => {
    render(
      <TargetAudioLane
        {...base}
        items={[item({}, "generated")]}
        takeVoiceFor={() => ({ takeVoiceName: "Narrator", lineVoiceName: "Naomi" })}
      />,
    )
    const left = bar()!.firstElementChild!
    const ids = Array.from(left.children).map((c) => c.getAttribute("data-testid"))
    expect(ids).toEqual(["tl-target-c1-generated", "tl-target-c1-name", "tl-target-c1-take-voice"])
    const voice = screen.getByTestId("tl-target-c1-take-voice")
    expect(voice).toHaveTextContent("Narrator")
    // Lighter: weight 500 at 72%.
    expect(voice.className).toContain("font-medium")
    expect(voice.className).toContain("opacity-[0.72]")
  })

  it("puts nothing on the waveform any more: no corner buttons, no floating voice label", () => {
    render(
      <TargetAudioLane
        {...base}
        items={[item({}, "generated")]}
        onOpenRecording={vi.fn()}
        takeMenu={menu()}
        takeVoiceFor={() => ({ takeVoiceName: "Narrator", lineVoiceName: "Naomi" })}
      />,
    )
    const b = bar()!
    for (const id of ["generated", "name", "take-voice", "record", "more"]) {
      expect(b.contains(screen.getByTestId(`tl-target-c1-${id}`)), id).toBe(true)
    }
  })
})

describe("the bar's right end", () => {
  const session = { jwt: "t", username: "sam" } as never
  const approved = () => item({ validatorCount: 1, validators: ["sam"] })

  it("carries the approval check in the approved green", () => {
    render(<TargetAudioLane {...base} items={[approved()]} session={session} />)
    const check = screen.getByTestId("tl-target-c1-validated")
    expect(bar()!.contains(check)).toBe(true)
    expect(check.className).toContain("text-green-700")
  })

  // Before the bar, a validated take's corner tick showed at every width. A
  // narrow take (or one drawn short where it collides) must still say so.
  it("carries the check on a take of any width, before the sparkle where both can't fit", () => {
    const narrow = (durationMs: number, kind: "take" | "generated" = "take") =>
      item({ validatorCount: 1, validators: ["sam"], durationMs }, kind)
    // 0.6 s at 40 px/s = 24px.
    const { unmount } = render(<TargetAudioLane {...base} items={[narrow(600)]} session={session} />)
    expect(bar()!.contains(screen.getByTestId("tl-target-c1-validated"))).toBe(true)
    unmount()
    // A 30px AI voice: the check is a state, the sparkle an identity — state wins.
    render(<TargetAudioLane {...base} items={[narrow(750, "generated")]} session={session} />)
    expect(screen.getByTestId("tl-target-c1-validated")).toBeInTheDocument()
    expect(screen.queryByTestId("tl-target-c1-generated")).toBeNull()
  })

  it("swaps the check for the record button and the ⋯ on hover", () => {
    render(<TargetAudioLane {...base} items={[approved()]} session={session} onOpenRecording={vi.fn()} takeMenu={menu()} />)
    const check = screen.getByTestId("tl-target-c1-validated")
    const hover = screen.getByTestId("tl-target-c1-bar-hover")
    // At rest: the check shows, the hover glyphs wait out of sight for the pointer.
    expect(check.className).toContain("group-hover/chip:hidden")
    expect(hover.className).toContain("opacity-0")
    expect(hover.className).toContain("group-hover/chip:opacity-100")
    fireEvent.pointerEnter(screen.getByTestId("tl-target-c1"))
    expect(screen.getByTestId("tl-target-c1-validated").className).toMatch(/(^|\s)hidden(\s|$)/)
    expect(screen.getByTestId("tl-target-c1-bar-hover").className).toMatch(/(^|\s)flex(\s|$)/)
    expect(screen.getByTestId("tl-target-c1-bar-hover").className).not.toContain("opacity-0")
    const ids = Array.from(screen.getByTestId("tl-target-c1-bar-hover").children).map((c) => c.getAttribute("data-testid"))
    expect(ids).toEqual(["tl-target-c1-record", "tl-target-c1-more"])
  })

  // The play button (top left before the bar) joins them only where the name
  // keeps room to be double-clicked beside all three.
  it("adds the play button only where the name keeps room beside it", () => {
    const factory = () => ({ prime: async () => "ready" as const, play: () => ({ stop() {}, isPlaying: () => false, positionSec: () => null, audible: true }) })
    const { unmount } = render(<TargetAudioLane {...base} items={[item({ durationMs: 3000 })]} onOpenRecording={vi.fn()} takeMenu={menu()} previewFactory={factory} />)
    // 3 s at 40 px/s = 120px.
    expect(Array.from(screen.getByTestId("tl-target-c1-bar-hover").children).map((c) => c.getAttribute("data-testid"))).toEqual(
      ["tl-target-c1-play", "tl-target-c1-record", "tl-target-c1-more"],
    )
    unmount()
    render(<TargetAudioLane {...base} items={[item({ durationMs: 2000 })]} onOpenRecording={vi.fn()} takeMenu={menu()} previewFactory={factory} />)
    // 2 s = 80px: record and ⋯ only.
    expect(screen.queryByTestId("tl-target-c1-play")).toBeNull()
    expect(screen.getByTestId("tl-target-c1-record")).toBeInTheDocument()
  })

  // The glyphs sit after the chip in the tab order, so Shift+Tab from the
  // next take arrives at them while this chip is not hovered: they must not be
  // display:none then, only out of sight.
  it("keeps the glyphs in the tab order at rest", () => {
    render(<TargetAudioLane {...base} items={[item()]} onOpenRecording={vi.fn()} takeMenu={menu()} />)
    const hover = screen.getByTestId("tl-target-c1-bar-hover")
    expect(hover.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    for (const id of ["record", "more"]) expect(screen.getByTestId(`tl-target-c1-${id}`).tabIndex, id).toBe(0)
  })

  it("keeps a glyph that has keyboard focus showing after the pointer leaves", () => {
    render(<TargetAudioLane {...base} items={[item()]} onOpenRecording={vi.fn()} takeMenu={menu()} />)
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerEnter(chip)
    const more = screen.getByTestId("tl-target-c1-more")
    act(() => more.focus())
    fireEvent.pointerLeave(chip)
    expect(document.activeElement).toBe(more)
    const hover = screen.getByTestId("tl-target-c1-bar-hover")
    expect(hover.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(hover.className).not.toContain("opacity-0")
  })

  it("draws the glyphs bare, with no button around them", () => {
    render(<TargetAudioLane {...base} items={[item()]} onOpenRecording={vi.fn()} takeMenu={menu()} />)
    for (const id of ["record", "more"]) {
      const g = screen.getByTestId(`tl-target-c1-${id}`)
      // (Only keyboard focus draws a ring, so a focused glyph can be found.)
      expect(g.className, id).not.toMatch(/(^|\s)ring-1/)
      expect(g.className, id).not.toContain("shadow")
      expect(g.className, id).not.toContain("bg-background")
    }
  })

  it("records from the bar without starting a move", () => {
    const onOpenRecording = vi.fn()
    const onRetimeTarget = vi.fn()
    render(<TargetAudioLane {...base} items={[item()]} onOpenRecording={onOpenRecording} onRetimeTarget={onRetimeTarget} />)
    const mic = screen.getByTestId("tl-target-c1-record")
    fireEvent.pointerDown(mic, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 180 })
    fireEvent.pointerUp(window, { clientX: 180 })
    fireEvent.click(mic)
    expect(onOpenRecording).toHaveBeenCalledWith("c1")
    expect(onRetimeTarget).not.toHaveBeenCalled()
  })
})

describe("the bar gives way from the right as the clip narrows", () => {
  const voiced = (durationMs: number) => (
    <TargetAudioLane
      {...base}
      items={[item({ durationMs }, "generated")]}
      takeVoiceFor={() => ({ takeVoiceName: "Narrator", lineVoiceName: "Naomi" })}
      onOpenRecording={vi.fn()}
    />
  )
  // At 40 px/s: 4 s = 160px, 3 s = 120px, 1 s = 40px, 0.5 s = 20px.
  it("keeps the voice from 150px wide", () => {
    render(voiced(4000))
    expect(screen.getByTestId("tl-target-c1-take-voice")).toBeInTheDocument()
  })

  it("lets the voice go first", () => {
    render(voiced(3000))
    expect(screen.queryByTestId("tl-target-c1-take-voice")).toBeNull()
    expect(screen.getByTestId("tl-target-c1-name")).toBeInTheDocument()
  })

  it("then the name, leaving the sparkle and the colour", () => {
    render(voiced(1000))
    expect(screen.queryByTestId("tl-target-c1-name")).toBeNull()
    expect(screen.getByTestId("tl-target-c1-generated")).toBeInTheDocument()
    expect(bar()).toBeInTheDocument()
    // 40px is under the 60px the record button needs in the bar.
    expect(screen.queryByTestId("tl-target-c1-record")).toBeNull()
  })

  it("keeps the bar's colour on the narrowest clip", () => {
    render(voiced(500))
    expect(bar()!.className).toContain("bg-[color:var(--tl-track-bar)]")
  })
})

// A double-click happens under the pointer: with the hover glyphs in the
// check's place, and often just after the first click put a state glyph up.
// So the name shows only where it keeps room for one beside them.
describe("the name keeps room to be double-clicked", () => {
  // At 40 px/s, a take of px × 25 ms is px wide.
  const at = (px: number, over: Record<string, unknown> = {}, kind: "take" | "generated" = "take") =>
    item({ durationMs: px * 25, ...over }, kind)
  const name = () => screen.queryByTestId("tl-target-c1-name")

  it("is left out, not crushed, where the ⋯ beside it would leave it no room", () => {
    // A 55px AI voice: the sparkle, the name, and on hover the ⋯.
    render(<TargetAudioLane {...base} items={[at(55, {}, "generated")]} takeMenu={menu()} />)
    expect(name()).toBeNull()
    expect(screen.getByTestId("tl-target-c1-more")).toBeInTheDocument()
    expect(screen.getByTestId("tl-target-c1-generated")).toBeInTheDocument()
  })

  it("shows where it keeps its room beside the ⋯", () => {
    render(<TargetAudioLane {...base} items={[at(70, {}, "generated")]} takeMenu={menu()} />)
    expect(name()).toBeInTheDocument()
  })

  it("comes before a passing state glyph, which shows only where there is room for both", () => {
    // A 60px take still saving, with the ⋯ on hover.
    const { unmount } = render(<TargetAudioLane {...base} items={[at(60, { pendingSync: true })]} takeMenu={menu()} />)
    expect(name()).toBeInTheDocument()
    expect(screen.queryByTestId("tl-target-c1-saving")).toBeNull()
    unmount()
    render(<TargetAudioLane {...base} items={[at(120, { pendingSync: true })]} takeMenu={menu()} />)
    expect(name()).toBeInTheDocument()
    expect(screen.getByTestId("tl-target-c1-saving")).toBeInTheDocument()
  })

  it("keeps the record button off a take where it would take the name's room", () => {
    // 64px: the name and the ⋯ fit, the record button beside them does not.
    render(<TargetAudioLane {...base} items={[at(64)]} takeMenu={menu()} onOpenRecording={vi.fn()} />)
    expect(name()).toBeInTheDocument()
    expect(screen.queryByTestId("tl-target-c1-record")).toBeNull()
    expect(screen.getByTestId("tl-target-c1-more")).toBeInTheDocument()
  })
})

describe("double-click the name to rename", () => {
  it("opens the take menu's own Rename, with the take's name", () => {
    const actions = menu()
    const onSeek = vi.fn()
    render(<TargetAudioLane {...base} items={[item()]} takeMenu={actions} onSeek={onSeek} />)
    fireEvent.doubleClick(screen.getByTestId("tl-target-c1-name"))
    expect(actions.rename).toHaveBeenCalledWith("c1", TAKE, "Take 2")
    // …and is not also the chip's double-click (which jumps to the line).
    expect(onSeek).not.toHaveBeenCalled()
  })

  it("renames a piece's whole take, by the take's own name", () => {
    const PIECE = "audio-c1-1700000500-piece.webm"
    const c = cell({
      [TAKE]: { type: "audio", url: "frontier-audio://t", slot: "recording", label: "Take 2 · 1", durationMs: 8000, trimEndMs: 3000 },
      [PIECE]: { type: "audio", url: "frontier-audio://t", slot: "recording", label: "Take 2 · 2", pieceOf: TAKE, durationMs: 8000, trimStartMs: 3000 },
    })
    const actions = menu()
    render(
      <TargetAudioLane
        {...base}
        takeMenu={actions}
        items={[
          { cell: c, kind: "take", audioId: TAKE, pieceIndex: 0, pieceCount: 2 },
          { cell: c, kind: "take", audioId: PIECE, pieceIndex: 1, pieceCount: 2 },
        ]}
      />,
    )
    fireEvent.doubleClick(screen.getByTestId("tl-target-c1-p2-name"))
    expect(actions.rename).toHaveBeenCalledWith("c1", PIECE, "Take 2")
  })

  // A real browser never delivers that double-click to the name: the press
  // starts the chip's move drag, whose pointer capture sends the click and the
  // double-click to the chip. So the chip asks where it landed.
  it("renames when the double-click reaches the chip but landed on the name (the drag's pointer capture)", () => {
    const actions = menu()
    const onSeek = vi.fn()
    render(<TargetAudioLane {...base} items={[item()]} takeMenu={actions} onSeek={onSeek} />)
    const name = screen.getByTestId("tl-target-c1-name")
    name.getBoundingClientRect = () => ({ left: 405, top: 11, right: 450, bottom: 25, width: 45, height: 14, x: 405, y: 11, toJSON: () => ({}) })
    fireEvent.doubleClick(screen.getByTestId("tl-target-c1"), { clientX: 420, clientY: 18 })
    expect(actions.rename).toHaveBeenCalledWith("c1", TAKE, "Take 2")
    expect(onSeek).not.toHaveBeenCalled()
    // …and off the name, on the waveform, it is still the jump to the line.
    fireEvent.doubleClick(screen.getByTestId("tl-target-c1"), { clientX: 420, clientY: 40 })
    expect(onSeek).toHaveBeenCalledWith("c1")
    expect(actions.rename).toHaveBeenCalledTimes(1)
  })

  it("still jumps to the line on a double-click over the waveform", () => {
    const actions = menu()
    const onSeek = vi.fn()
    render(<TargetAudioLane {...base} items={[item()]} takeMenu={actions} onSeek={onSeek} />)
    fireEvent.doubleClick(screen.getByTestId("tl-target-c1"))
    expect(onSeek).toHaveBeenCalledWith("c1")
    expect(actions.rename).not.toHaveBeenCalled()
  })

  it("does nothing for someone who cannot change the take", () => {
    const actions = menu()
    render(<TargetAudioLane {...base} editable={false} items={[item()]} takeMenu={actions} />)
    fireEvent.doubleClick(screen.getByTestId("tl-target-c1-name"))
    expect(actions.rename).not.toHaveBeenCalled()
  })
})

describe("drag the bar to move the take", () => {
  it("moves it through the chip's own retime", () => {
    const onRetimeTarget = vi.fn()
    render(<TargetAudioLane {...base} items={[item({ durationMs: 4000 })]} onRetimeTarget={onRetimeTarget} />)
    // Grab the bar by the name: 40px right at 40 px/s is one second later.
    fireEvent.pointerDown(screen.getByTestId("tl-target-c1-name"), { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140 })
    fireEvent.pointerUp(window, { clientX: 140 })
    expect(onRetimeTarget).toHaveBeenCalledTimes(1)
    const [cellId, anchor, audioId] = onRetimeTarget.mock.calls[0]
    expect(cellId).toBe("c1")
    expect(audioId).toBe(TAKE)
    expect(anchor).toBeCloseTo(11)
  })

  it("leaves trimming to the handles, which start under the bar", () => {
    render(<TargetAudioLane {...base} masterHonorsTrims items={[item({ durationMs: 4000 })]} onTrimTarget={vi.fn()} />)
    expect(screen.getByTestId("tl-target-c1-handle-l").style.top).toBe("14px")
    expect(screen.getByTestId("tl-target-c1-handle-r").style.top).toBe("14px")
  })
})

describe("what the bar leaves alone", () => {
  it("keeps the selection ring on the clip, bar and all", () => {
    render(<TargetAudioLane {...base} items={[item()]} selectedTakeCellId="c1" />)
    expect(screen.getByTestId("tl-target-c1").className).toContain("ring-2 ring-sky-500")
  })

  it("fades a muted track's clip whole, bar included", () => {
    render(<TargetAudioLane {...base} items={[item()]} muted />)
    const chip = screen.getByTestId("tl-target-c1")
    expect(chip.style.opacity).toBe("0.5")
    expect(chip.contains(bar())).toBe(true)
  })
})
