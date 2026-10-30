// AQU-2252: following the recordings, a take on an added track — drawn at its
// own length, trimmed and moved on its own. This is the chip's half: what it
// draws, and what a drag or a trim commits.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
vi.mock("@/lib/audio/transport-pause", () => ({ pauseAllTransports: vi.fn() }))

import { TargetAudioLane } from "./TargetAudioLane"
import { buildTimelineLayout } from "@/lib/timeline/layout"
import type { CellData } from "@/hooks/useCells"

const TRACK = "trk-1"
const MAIN = "audio-l2-1700000000-main.wav"
const LAYER = "audio-l2-1700000500-layer.wav"
const PX = 40

/** Ruth's line 3 in round numbers: line 1 lasts 2 s; line 2's main take is
 *  2.9 s; its Track 1 take is 2.055 s of a 3.141 s recording. */
function lines(layer: { targetOffsetMs: number }) {
  const l1 = {
    id: "l1", fileId: "f1", original: "l1 words", translated: "", medium: "text",
    selectedAudioId: "audio-l1-1700000000-main.wav",
    attachments: { "audio-l1-1700000000-main.wav": { type: "audio", url: "frontier-audio://m1", slot: "recording", durationMs: 2000 } },
  } as unknown as CellData
  const l2 = {
    id: "l2", fileId: "f1", original: "l2 words", translated: "", medium: "text",
    selectedAudioId: MAIN,
    selectedBySlot: { [TRACK]: LAYER },
    attachments: {
      [MAIN]: { type: "audio", url: "frontier-audio://m2", slot: "recording", durationMs: 4000, trimStartMs: 1000, trimEndMs: 3900 },
      [LAYER]: { type: "audio", url: "frontier-audio://layer", slot: TRACK, durationMs: 3141, trimStartMs: 841, trimEndMs: 2896, ...layer },
    },
  } as unknown as CellData
  return [l1, l2]
}

function renderLayer(
  layer: { targetOffsetMs: number },
  props: Pick<Parameters<typeof TargetAudioLane>[0], "onRetimeTarget" | "onTrimTarget"> = {},
) {
  const cells = lines(layer)
  const layout = buildTimelineLayout("audioFirst", cells, cells, null, { standInLenSec: () => 2 })
  render(
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
      items={[{ cell: cells[1], kind: "take", audioId: LAYER }]}
      laneTestId={`tl-target-lane-${TRACK}`}
      {...props}
    />,
  )
  return screen.getByTestId("tl-target-l2")
}

// Sam, Oct 29: every track sets its lines' lengths by default, so a take on an
// added track sits in its line the way the main take does — after the pause
// someone left before it — and moves and trims the way the main take does.
describe("a take on an added track, following the recordings (AQU-2252)", () => {
  it("is drawn at its own length, after its own pause in its line", () => {
    // Its clip's start placed 1 s into line 2 (which starts at 2 s).
    const chip = renderLayer({ targetOffsetMs: 1000 })
    expect(parseFloat(chip.style.left)).toBeCloseTo(3 * PX, 1)
    expect(parseFloat(chip.style.width)).toBeCloseTo(2.055 * PX, 1)
  })

  it("a drag stores the take's own pause, for the take", () => {
    const onRetimeTarget = vi.fn()
    const chip = renderLayer({ targetOffsetMs: 1000 }, { onRetimeTarget })
    fireEvent.pointerDown(chip, { clientX: 200, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 226 })
    fireEvent.pointerUp(window, { clientX: 226 }) // +0.65 s → sounds from 3.65 s
    expect(onRetimeTarget).toHaveBeenCalledTimes(1)
    const [cellId, anchor, audioId] = onRetimeTarget.mock.calls[0]!
    expect(cellId).toBe("l2")
    expect(audioId).toBe(LAYER)
    // 1.65 s into its line: the pause before it.
    expect(anchor).toBeCloseTo(1.65, 3)
  })

  it("a head trim keeps the take's own tail", () => {
    const onTrimTarget = vi.fn()
    renderLayer({ targetOffsetMs: 1000 }, { onTrimTarget })
    const handle = screen.getByTestId("tl-target-l2-handle-l")
    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 220 })
    fireEvent.pointerUp(window, { clientX: 220 }) // +0.5 s
    expect(onTrimTarget).toHaveBeenCalledWith("l2", LAYER, { trimStartMs: 1341, trimEndMs: 2896 })
  })

  it("its tail trims out to the whole recording", () => {
    const onTrimTarget = vi.fn()
    renderLayer({ targetOffsetMs: 1000 }, { onTrimTarget })
    const handle = screen.getByTestId("tl-target-l2-handle-r")
    fireEvent.pointerDown(handle, { clientX: 236, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 600 })
    fireEvent.pointerUp(window, { clientX: 600 }) // far past the recording's end
    expect(onTrimTarget).toHaveBeenCalledWith("l2", LAYER, { trimStartMs: 841, trimEndMs: undefined })
  })

  it("its head trim comes all the way back off, as the main take's does", () => {
    const onTrimTarget = vi.fn()
    renderLayer({ targetOffsetMs: 1000 }, { onTrimTarget })
    const handle = screen.getByTestId("tl-target-l2-handle-l")
    fireEvent.pointerDown(handle, { clientX: 120, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 0 })
    fireEvent.pointerUp(window, { clientX: 0 })
    expect(onTrimTarget).toHaveBeenCalledWith("l2", LAYER, { trimStartMs: undefined, trimEndMs: 2896 })
  })

  it("shows no running-long warning: its line grows to hold it", () => {
    const chip = renderLayer({ targetOffsetMs: 1000 })
    expect(chip.getAttribute("data-overflow")).toBe("none")
  })
})

// ── A track made a layer (Sam, Oct 29) ─────────────────────────────────────
// Music, sound effects, ambience: its takes set no line's length, and they
// behave the way takes do following the source — measured against their line,
// amber running past it, red over the next take on the same track (drawn short
// with an outward chevron, whole on hover), a lead-in allowed, the move clamp
// stopping at a neighbour, and no dropping onto another line.

type TrackTake = { durationMs: number; trimStartMs?: number; trimEndMs?: number; targetOffsetMs: number }
const trackTakeId = (id: string) => `audio-${id}-1700000500-track.wav`

/** l1 2 s · l2 2.9 s · l3 2 s on the main track (lines 0–2, 2–4.9, 4.9–6.9),
 *  with these takes on Track 1. */
function layerLines(takes: Partial<Record<"l1" | "l2" | "l3", TrackTake>>) {
  const mains: Record<string, object> = {
    l1: { durationMs: 2000 },
    l2: { durationMs: 4000, trimStartMs: 1000, trimEndMs: 3900 },
    l3: { durationMs: 2000 },
  }
  return (["l1", "l2", "l3"] as const).map((id) => {
    const mainId = `audio-${id}-1700000000-main.wav`
    const take = takes[id]
    return {
      id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
      selectedAudioId: mainId,
      ...(take ? { selectedBySlot: { [TRACK]: trackTakeId(id) } } : {}),
      attachments: {
        [mainId]: { type: "audio", url: `frontier-audio://${id}`, slot: "recording", ...mains[id] },
        ...(take ? { [trackTakeId(id)]: { type: "audio", url: `frontier-audio://${id}-track`, slot: TRACK, ...take } } : {}),
      },
    } as unknown as CellData
  })
}

/** Ruth's Track 1 take on l2: 2.055 s of a 3.141 s recording, its sample zero
 *  1 s into the line → sounds 3.841–5.896 s, a second past l2's end. */
const L2: TrackTake = { durationMs: 3141, trimStartMs: 841, trimEndMs: 2896, targetOffsetMs: 1000 }

function renderLayerTrack(
  takes: Partial<Record<"l1" | "l2" | "l3", TrackTake>>,
  props: Pick<Parameters<typeof TargetAudioLane>[0], "onRetimeTarget" | "onTrimTarget"> = {},
  mode: "audioFirst" | "dubbing" = "audioFirst",
) {
  const cells = layerLines(takes)
  const layout = buildTimelineLayout(mode, cells, cells, null, { standInLenSec: () => 2, layerTrackSlots: [TRACK] })
  render(
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
      items={cells.filter((c) => takes[c.id as "l1"]).map((cell) => ({ cell, kind: "take" as const, audioId: trackTakeId(cell.id) }))}
      laneTestId={`tl-target-lane-${TRACK}`}
      {...props}
    />,
  )
}

const drag = (el: HTMLElement, fromX: number, toX: number) => {
  fireEvent.pointerDown(el, { clientX: fromX, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: toX })
  fireEvent.pointerUp(window, { clientX: toX })
}

describe("a take on a track made a layer, following the recordings (AQU-2252, Oct 29)", () => {
  it("is drawn where it was placed, at its own length, and its line keeps its length", () => {
    renderLayerTrack({ l2: L2 })
    const chip = screen.getByTestId("tl-target-l2")
    expect(parseFloat(chip.style.left)).toBeCloseTo(3.841 * PX, 1)
    expect(parseFloat(chip.style.width)).toBeCloseTo(2.055 * PX, 1)
  })

  it("turns amber when it runs past its line", () => {
    renderLayerTrack({ l2: L2 })
    expect(screen.getByTestId("tl-target-l2").getAttribute("data-overflow")).toBe("soft")
  })

  it("turns red over the next take on its track, and is drawn short with an outward chevron — whole on hover", () => {
    // l3's take starts on its line, at 4.9 s: inside l2's take.
    renderLayerTrack({ l2: L2, l3: { durationMs: 1000, targetOffsetMs: 0 } })
    const chip = screen.getByTestId("tl-target-l2")
    expect(chip.getAttribute("data-overflow")).toBe("overlap")
    // At rest it yields at l3's take, and says so with a chevron.
    expect(parseFloat(chip.style.width)).toBeCloseTo((4.9 - 3.841) * PX, 1)
    expect(screen.getByTestId("tl-target-l2-overflow")).toBeTruthy()
    // The innocent one is drawn whole and stays calm.
    expect(screen.getByTestId("tl-target-l3").getAttribute("data-overflow")).toBe("none")
    fireEvent.pointerEnter(chip)
    expect(parseFloat(chip.style.width)).toBeCloseTo(2.055 * PX, 1)
  })

  it("may be moved to start before its line — a lead-in — and is stopped by the previous take on its track", () => {
    const onRetimeTarget = vi.fn()
    // l1's take starts at 1.2 s.
    renderLayerTrack({ l1: { durationMs: 800, targetOffsetMs: 1200 }, l2: L2 }, { onRetimeTarget })
    drag(screen.getByTestId("tl-target-l2"), 200, 0) // 5 s to the left
    const [cellId, anchor, audioId] = onRetimeTarget.mock.calls[0]!
    expect([cellId, audioId]).toEqual(["l2", trackTakeId("l2")])
    // It sounds from l1's take's start, 1.2 s: 0.8 s before its line, its
    // sample zero a 0.841 s head trim before that.
    expect(anchor).toBeCloseTo(1.2 - 2 - 0.841, 3)
  })

  it("is stopped by the next take on its track", () => {
    const onRetimeTarget = vi.fn()
    // l3's take leads in to start at 4.5 s, before l2 ends.
    renderLayerTrack({ l2: L2, l3: { durationMs: 1000, targetOffsetMs: -400 } }, { onRetimeTarget })
    drag(screen.getByTestId("tl-target-l2"), 200, 600) // 10 s to the right
    // It may start no later than l3's take: 4.5 s, 2.5 s into its line.
    expect(onRetimeTarget.mock.calls[0]![1]).toBeCloseTo(2.5 - 0.841, 3)
  })

  it("can't be dropped onto another line: it keeps touching its own", () => {
    const onRetimeTarget = vi.fn()
    renderLayerTrack({ l2: L2 }, { onRetimeTarget })
    drag(screen.getByTestId("tl-target-l2"), 200, 1000) // 20 s to the right
    // Its start stops just inside its line's end (4.9 s, less the 0.05 s grip).
    expect(onRetimeTarget.mock.calls[0]![1]).toBeCloseTo(4.85 - 2 - 0.841, 3)
  })

  it("its head trim comes back off before its line, but not past the previous take on its track", () => {
    const onTrimTarget = vi.fn()
    // Sample zero 1.5 s before l2 → it sounds from 1.341 s; l1's take starts at 1 s.
    renderLayerTrack({ l1: { durationMs: 500, targetOffsetMs: 1000 }, l2: { ...L2, targetOffsetMs: -1500 } }, { onTrimTarget })
    drag(screen.getByTestId("tl-target-l2-handle-l"), 54, 0)
    // Its sample zero is at 0.5 s, so un-trimming stops at l1's take's 1 s start: 0.5 s still trimmed.
    expect(onTrimTarget).toHaveBeenCalledWith("l2", trackTakeId("l2"), { trimStartMs: 500, trimEndMs: 2896 })
  })
})

describe("following the source, a layer track's takes are drawn as every take is (AQU-2252)", () => {
  it("is the same chip with or without the switch", () => {
    const timed = (layered: boolean) => {
      const cells = layerLines({ l2: L2 }).map((c, i) => ({ ...c, startTime: i * 3, endTime: i * 3 + 3, medium: "media" }) as unknown as CellData)
      const layout = buildTimelineLayout("dubbing", cells, cells, null, { standInLenSec: () => 2, ...(layered ? { layerTrackSlots: [TRACK] } : {}) })
      const { unmount } = render(
        <TargetAudioLane
          validationRequirementAudio={1} pxPerSec={PX} viewStartSec={0} viewEndSec={100} selectedId={null}
          editable snapEnabled={false} onSelect={() => {}} layout={layout}
          items={[{ cell: cells[1], kind: "take", audioId: trackTakeId("l2") }]}
        />,
      )
      const chip = screen.getByTestId("tl-target-l2")
      const out = [chip.style.left, chip.style.width, chip.getAttribute("data-overflow")]
      unmount()
      return out
    }
    expect(timed(true)).toEqual(timed(false))
  })
})
