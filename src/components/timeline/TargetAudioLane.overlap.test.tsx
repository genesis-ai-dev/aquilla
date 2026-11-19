// AQU-2432 (Sam, Nov 6, question 5): following the recordings a take can be
// dragged earlier, over the end of the take before it on its track. How the
// two look: AS TODAY, WITH THE RED WARNING — the look two takes that collide
// following the source already wear. The take moved over the one before it is
// drawn red, starting where the earlier take ends, with the small arrow strip
// at its start; hovering draws it whole; its right-click details say how much
// it overlaps, in red. The same on an added track; a selected or hovered take
// still comes to the front. Overlap is allowed but marked as not desirable.

import { describe, it, expect, vi } from "vitest"
import { screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithTooltips } from "@/test-utils/tooltip"
vi.mock("@/lib/audio/transport-pause", () => ({ pauseAllTransports: vi.fn() }))

import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import { buildTimelineLayout } from "@/lib/timeline/layout"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
const TRACK = "01a17e67-ef58-74f7-a093-be935876197b"
const PX = 40

type Take = { durationMs: number; trimStartMs?: number; trimEndMs?: number; recordingsOffsetMs?: number; pieceOf?: string }
const takeId = (id: string) => `audio-${id}-1700000000-take.wav`
const voiceId = (id: string) => `audio-${id}-1700000500-voice.wav`

/** A timed line with a take on the main track or, `onTrack`, on Track 1. */
function line(id: string, startTime: number, endTime: number, take: Take, onTrack = false): CellData {
  const aid = onTrack ? voiceId(id) : takeId(id)
  return {
    id, fileId: "f1", original: id, translated: "", medium: "media", startTime, endTime,
    ...(onTrack ? { selectedBySlot: { [TRACK]: aid } } : { selectedAudioId: aid }),
    attachments: {
      [aid]: { type: "audio", url: "frontier-audio://take", slot: onTrack ? TRACK : "recording", ...take },
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
    },
  } as unknown as CellData
}

/** Mia's line 4 (a 3 s take), Lee's line 5 (2 s) pulled `leeMs` back over it. */
const scene = (leeMs: number, onTrack = false) => [
  line("l4", 0, 3, { durationMs: 3_000 }, onTrack),
  line("l5", 3, 5, { durationMs: 2_000, recordingsOffsetMs: leeMs }, onTrack),
]

function renderScene(
  cells: CellData[],
  opts: { onTrack?: boolean; items?: TargetAudioItem[] } & Partial<Parameters<typeof TargetAudioLane>[0]> = {},
) {
  const { onTrack = false, items, ...props } = opts
  const layout = buildTimelineLayout("audioFirst", cells, cells, null, onTrack ? { layerSlots: [TRACK] } : undefined)
  const ui = (
    <TargetAudioLane
      validationRequirementAudio={1}
      pxPerSec={PX}
      viewStartSec={0}
      viewEndSec={100}
      selectedId={null}
      editable
      snapEnabled={false}
      onSelect={() => {}}
      layout={layout}
      items={items ?? cells.map((cell) => ({ cell, kind: "take" as const, audioId: onTrack ? voiceId(cell.id) : takeId(cell.id) }))}
      {...props}
    />
  )
  return renderWithTooltips(ui)
}

const left = (el: HTMLElement) => parseFloat(el.style.left) / PX
const width = (el: HTMLElement) => parseFloat(el.style.width) / PX

describe("a take pulled back over the take before it, following the recordings (AQU-2432)", () => {
  it("is red and drawn from where the earlier take ends, with the arrow strip at its start; the earlier one is drawn whole", () => {
    renderScene(scene(-600))
    const lee = screen.getByTestId("tl-target-l5")
    expect(lee).toHaveAttribute("data-overflow", "overlap")
    expect(lee).toHaveAttribute("data-truncated", "start")
    expect(lee.className).toContain("bg-red-100")
    expect(left(lee)).toBeCloseTo(3, 2)
    expect(width(lee)).toBeCloseTo(1.4, 2)
    expect(screen.getByTestId("tl-target-l5-overflow-head")).toBeInTheDocument()
    // Its true span is where it was put.
    expect(lee).toHaveAttribute("data-span-start", "2.400")
    const mia = screen.getByTestId("tl-target-l4")
    expect(mia).toHaveAttribute("data-overflow", "none")
    expect(mia).not.toHaveAttribute("data-truncated")
    expect(width(mia)).toBeCloseTo(3, 2)
  })

  it("hovering draws it whole, in front of the take before it", () => {
    renderScene(scene(-600))
    const lee = screen.getByTestId("tl-target-l5")
    const mia = screen.getByTestId("tl-target-l4")
    fireEvent.pointerEnter(lee)
    expect(left(lee)).toBeCloseTo(2.4, 2)
    expect(width(lee)).toBeCloseTo(2, 2)
    expect(screen.queryByTestId("tl-target-l5-overflow-head")).toBeNull()
    expect(Number(lee.style.zIndex)).toBeGreaterThan(Number(mia.style.zIndex))
    fireEvent.pointerLeave(lee)
    expect(left(lee)).toBeCloseTo(3, 2)
  })

  it("its right-click details say how much it overlaps, in red", async () => {
    renderScene(scene(-600))
    const lee = screen.getByTestId("tl-target-l5")
    await userEvent.setup().hover(lee)
    fireEvent.contextMenu(lee, { button: 2 })
    const details = await screen.findByTestId("tl-take-details-l5")
    expect(details.textContent).toMatch(/−0\.6s.*Overlaps the previous dub/)
    expect(screen.getByTestId("tl-target-l5-tip-overlap-head").parentElement?.className).toContain("text-red")
  })

  it("a selected take comes to the front too", () => {
    renderScene(scene(-600), { selectedId: "l4", selectedTakeCellId: "l4" })
    expect(Number(screen.getByTestId("tl-target-l4").style.zIndex)).toBeGreaterThan(Number(screen.getByTestId("tl-target-l5").style.zIndex))
  })

  it("takes end to end are not marked, as before", () => {
    renderScene(scene(0))
    expect(screen.getByTestId("tl-target-l5")).toHaveAttribute("data-overflow", "none")
    expect(screen.getByTestId("tl-target-l5")).not.toHaveAttribute("data-truncated")
  })

  it("the same look on an added track", () => {
    renderScene(scene(-600, true), { onTrack: true, laneTestId: `tl-target-lane-${TRACK}` })
    const lee = screen.getByTestId("tl-target-l5")
    expect(lee).toHaveAttribute("data-overflow", "overlap")
    expect(lee).toHaveAttribute("data-truncated", "start")
    expect(left(lee)).toBeCloseTo(3, 2)
    expect(screen.getByTestId("tl-target-l4")).toHaveAttribute("data-overflow", "none")
  })

  it("a piece of a cut take over the end of the piece in front looks the same", () => {
    const TAKE = takeId("a")
    const PIECE = "audio-a-1700000900-piece.wav"
    const cell = {
      ...line("a", 0, 6, { durationMs: 4_000, trimEndMs: 1_500, recordingsOffsetMs: 0 }),
      attachments: {
        [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4_000, trimEndMs: 1_500, recordingsOffsetMs: 0 },
        [PIECE]: { type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: 4_000, trimStartMs: 2_500, trimEndMs: 3_700, recordingsOffsetMs: -1_000 },
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    } as unknown as CellData
    renderScene([cell], {
      items: [
        { cell, kind: "take", audioId: TAKE, pieceIndex: 0, pieceCount: 2 },
        { cell, kind: "take", audioId: PIECE, pieceIndex: 1, pieceCount: 2 },
      ],
    })
    const second = screen.getByTestId("tl-target-a-p2")
    expect(second).toHaveAttribute("data-overflow", "overlap")
    expect(left(second)).toBeCloseTo(1.5, 2)
    expect(screen.getByTestId("tl-target-a")).toHaveAttribute("data-overflow", "none")
  })
})

describe("dragging a take over the take before it (AQU-2432)", () => {
  const dragBy = (chip: HTMLElement, sec: number) => {
    fireEvent.pointerDown(chip, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 400 + sec * PX })
    fireEvent.pointerUp(window, { clientX: 400 + sec * PX })
  }

  it("1 s left: stored 1 s before where its line would start, in both timings", () => {
    const onRetimeTarget = vi.fn()
    renderScene(scene(0), { onRetimeTarget })
    dragBy(screen.getByTestId("tl-target-l5"), -1)
    expect(onRetimeTarget).toHaveBeenCalledTimes(1)
    const [cellId, , audioId, place] = onRetimeTarget.mock.calls[0]!
    expect([cellId, audioId]).toEqual(["l5", takeId("l5")])
    expect(place).toEqual({ targetOffsetMs: -1_000, recordingsOffsetMs: -1_000 })
  })

  it("is red while it is dragged over the take before it", () => {
    renderScene(scene(0), { onRetimeTarget: vi.fn() })
    const lee = screen.getByTestId("tl-target-l5")
    fireEvent.pointerDown(lee, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 400 - PX })
    expect(lee).toHaveAttribute("data-overflow", "overlap")
    fireEvent.pointerUp(window, { clientX: 400 - PX })
  })

  it("stops at the start of the take before it", () => {
    const onRetimeTarget = vi.fn()
    renderScene(scene(0), { onRetimeTarget })
    dragBy(screen.getByTestId("tl-target-l5"), -10)
    const [, , , place] = onRetimeTarget.mock.calls[0]!
    expect((place as { recordingsOffsetMs: number }).recordingsOffsetMs).toBe(-3_000)
  })
})
