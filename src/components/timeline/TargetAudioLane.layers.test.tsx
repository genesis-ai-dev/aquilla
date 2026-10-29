// AQU-2252 (Sam, Oct 28): following the recordings, a take on an added track
// is a LAYER — drawn at its own length, trimmed and moved on its own. This is
// the chip's half: what it draws, and what a drag or a trim commits.

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

describe("a layer chip, following the recordings (AQU-2252)", () => {
  it("is drawn at its own length, where it was placed", () => {
    // Sample zero 1 s into line 2 (which starts at 2 s), sounding 0.841 s later.
    const chip = renderLayer({ targetOffsetMs: 1000 })
    expect(parseFloat(chip.style.left)).toBeCloseTo(3.841 * PX, 1)
    expect(parseFloat(chip.style.width)).toBeCloseTo(2.055 * PX, 1)
  })

  it("a drag stores the layer's own offset, for the layer", () => {
    const onRetimeTarget = vi.fn()
    const chip = renderLayer({ targetOffsetMs: 1000 }, { onRetimeTarget })
    fireEvent.pointerDown(chip, { clientX: 200, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 226 })
    fireEvent.pointerUp(window, { clientX: 226 }) // +0.65 s → sounds from 4.491 s
    expect(onRetimeTarget).toHaveBeenCalledTimes(1)
    const [cellId, anchor, audioId] = onRetimeTarget.mock.calls[0]!
    expect(cellId).toBe("l2")
    expect(audioId).toBe(LAYER)
    // 2.491 s into its line, less its 0.841 s head trim.
    expect(anchor).toBeCloseTo(1.65, 3)
  })

  it("a head trim keeps the layer's own tail", () => {
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

  it("its head trim stops at its line's start", () => {
    const onTrimTarget = vi.fn()
    // Sample zero half a second BEFORE line 2's start: un-trimming the head
    // all the way would make it sound before its line.
    renderLayer({ targetOffsetMs: -500 }, { onTrimTarget })
    const handle = screen.getByTestId("tl-target-l2-handle-l")
    fireEvent.pointerDown(handle, { clientX: 94, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 0 })
    fireEvent.pointerUp(window, { clientX: 0 })
    // Line 2 starts at 2 s; the sample zero is at 1.5 s, so 0.5 s stays trimmed.
    expect(onTrimTarget).toHaveBeenCalledWith("l2", LAYER, { trimStartMs: 500, trimEndMs: 2896 })
  })
})
