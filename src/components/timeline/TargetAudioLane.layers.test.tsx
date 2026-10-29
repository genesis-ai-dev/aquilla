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
