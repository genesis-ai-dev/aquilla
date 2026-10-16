// AQU-1767 phase 1: the blade, and a cut take drawn as its pieces.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
vi.mock("@/lib/audio/transport-pause", () => ({ pauseAllTransports: vi.fn() }))

import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
const TAKE = "audio-c1-1700000000-take.wav"
const PIECE = "audio-c1-1700000500-piece.wav"

function cell(attachments: Record<string, object>): CellData {
  return {
    id: "c1", fileId: "f1", original: "", translated: "",
    medium: "media", startTime: 10, endTime: 20,
    selectedAudioId: TAKE,
    attachments: {
      ...attachments,
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src", slot: "recording", role: "source" },
    },
  } as unknown as CellData
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

describe("TargetAudioLane — cutting (AQU-1767)", () => {
  it("with the blade on, a click cuts the take where it lands, in the take's own ms, and does not seek", () => {
    const onCutTarget = vi.fn()
    const onSeek = vi.fn()
    const c = cell({ [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000 } })
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: c, kind: "take", audioId: TAKE }]}
        bladeActive
        onCutTarget={onCutTarget}
        onSeek={onSeek}
      />,
    )
    const chip = screen.getByTestId("tl-target-c1")
    expect(chip.hasAttribute("data-blade")).toBe(true)
    // happy-dom lays the chip at x = 0, so the pointer's x IS the offset into
    // the painted box: 80px at 40px/s = 2s into a take that starts at 10s.
    fireEvent.pointerDown(chip, { button: 0, clientX: 80, pointerId: 1 })
    fireEvent.click(chip)
    expect(onCutTarget).toHaveBeenCalledTimes(1)
    const [cellId, audioId, atMs] = onCutTarget.mock.calls[0]
    expect([cellId, audioId]).toEqual(["c1", TAKE])
    expect(atMs).toBeCloseTo(2000)
    expect(onSeek).not.toHaveBeenCalled()
  })

  it("never cuts too near an edge, and never without the blade", () => {
    const onCutTarget = vi.fn()
    const c = cell({ [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000 } })
    const { rerender } = render(
      <TargetAudioLane {...base} items={[{ cell: c, kind: "take", audioId: TAKE }]} bladeActive onCutTarget={onCutTarget} />,
    )
    // 2px in = 50ms: inside the 100ms the server refuses.
    fireEvent.pointerDown(screen.getByTestId("tl-target-c1"), { button: 0, clientX: 2, pointerId: 1 })
    expect(onCutTarget).not.toHaveBeenCalled()
    rerender(<TargetAudioLane {...base} items={[{ cell: c, kind: "take", audioId: TAKE }]} onCutTarget={onCutTarget} />)
    fireEvent.pointerDown(screen.getByTestId("tl-target-c1"), { button: 0, clientX: 80, pointerId: 1 })
    expect(onCutTarget).not.toHaveBeenCalled()
  })

  it("draws a cut take as one chip per piece, each where its window puts it", () => {
    const c = cell({
      [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimEndMs: 1500, label: "Take 1 · 1" },
      [PIECE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimStartMs: 1500, pieceOf: TAKE, label: "Take 1 · 2" },
    })
    const items: TargetAudioItem[] = [
      { cell: c, kind: "take", audioId: TAKE, pieceIndex: 0, pieceCount: 2 },
      { cell: c, kind: "take", audioId: PIECE, pieceIndex: 1, pieceCount: 2 },
    ]
    render(<TargetAudioLane {...base} items={items} />)
    const first = screen.getByTestId("tl-target-c1")
    const second = screen.getByTestId("tl-target-c1-p2")
    expect(first.getAttribute("data-audio-id")).toBe(TAKE)
    expect(second.getAttribute("data-audio-id")).toBe(PIECE)
    expect(first.getAttribute("data-piece")).toBe("1/2")
    // First piece: 10s → 11.5s. Second: 11.5s → 14s (same anchor, its own window).
    expect(Number(first.getAttribute("data-span-start"))).toBeCloseTo(10)
    expect(Number(first.getAttribute("data-span-end"))).toBeCloseTo(11.5)
    expect(Number(second.getAttribute("data-span-start"))).toBeCloseTo(11.5)
    expect(Number(second.getAttribute("data-span-end"))).toBeCloseTo(14)
  })
})

// AQU-1767 (Sam, 2026-10-15): a 4s take cut at 2.1s, then A trimmed to end at
// 1.6s and B to start at 2.8s. Each cut edge may come back out as far as the
// other piece's edge, never over it; moving a piece changes nothing.
describe("TargetAudioLane — a piece's cut edge (AQU-1767)", () => {
  const split = (bOffsetMs?: number) => {
    const c = cell({
      [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimEndMs: 1600, label: "Take 1 · 1" },
      [PIECE]: {
        type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimStartMs: 2800, pieceOf: TAKE, label: "Take 1 · 2",
        ...(bOffsetMs != null ? { targetOffsetMs: bOffsetMs } : {}),
      },
    })
    return [
      { cell: c, kind: "take" as const, audioId: TAKE, pieceIndex: 0, pieceCount: 2 },
      { cell: c, kind: "take" as const, audioId: PIECE, pieceIndex: 1, pieceCount: 2 },
    ]
  }
  const drag = (testId: string, from: number, to: number) => {
    const handle = screen.getByTestId(testId)
    fireEvent.pointerDown(handle, { clientX: from, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: to })
    fireEvent.pointerUp(window, { clientX: to })
  }

  it("lets A's end come back out freely up to where B starts, and no further", () => {
    const onTrimTarget = vi.fn()
    render(<TargetAudioLane {...base} items={split()} onTrimTarget={onTrimTarget} />)
    // A ends at 11.6s = 464px. +20px = 0.5s: free, inside the room.
    drag("tl-target-c1-handle-r", 464, 484)
    expect(onTrimTarget.mock.calls[0][2].trimEndMs).toBe(2100)
    // +80px = 2s would reach 3.6s of the recording: stops at B's start, 2.8s.
    drag("tl-target-c1-handle-r", 464, 544)
    expect(onTrimTarget.mock.calls[1][2].trimEndMs).toBe(2800)
  })

  it("lets B's start come back out up to where A ends, and no further", () => {
    const onTrimTarget = vi.fn()
    render(<TargetAudioLane {...base} items={split()} onTrimTarget={onTrimTarget} />)
    // B starts at 12.8s = 512px. −80px = 2s would reach 0.8s: stops at A's end, 1.6s.
    drag("tl-target-c1-p2-handle-l", 512, 432)
    const [cellId, audioId, trims] = onTrimTarget.mock.calls[0]
    expect([cellId, audioId]).toEqual(["c1", PIECE])
    expect(trims.trimStartMs).toBe(1600)
  })

  it("keeps the limit in the recording when B has been moved along the timeline", () => {
    const onTrimTarget = vi.fn()
    // B moved 3s later: it now sits well clear of A on the timeline.
    render(<TargetAudioLane {...base} items={split(3000)} onTrimTarget={onTrimTarget} />)
    drag("tl-target-c1-handle-r", 464, 600)
    expect(onTrimTarget.mock.calls[0][2].trimEndMs).toBe(2800)
  })
})
