// AQU-1767 phase 1: a take cut in two sounds piece by piece.
//
// Planned against the external (picture) master, whose sweep re-plans every
// tick, and against the queue master, which only re-plans when an ARM comes
// due — the reason a fired piece arms the next one (`nextDueSec`).
import { describe, it, expect } from "vitest"
import { overlayKey, overlayPieceKey, planTargetOverlay } from "./play-queue"
import type { CellData } from "@/hooks/useCells"

const A = "audio-a-1700000000-take.wav"
const B = "audio-a-1700000500-piece.wav"

/** Line at 10s–14s with its take cut at 1.5s: piece A 10–11.5s, piece B 11.5–14s,
 *  and piece B then moved half a second later (an offset of its own). */
function cutLine(bOffsetMs: number | null = null): CellData {
  return {
    id: "a", fileId: "f1", original: "", translated: "",
    medium: "text", startTime: 10, endTime: 14,
    selectedAudioId: A,
    attachments: {
      [A]: { type: "audio", url: "http://audio.test/a.wav", slot: "recording", durationMs: 4000, trimEndMs: 1500 },
      [B]: {
        type: "audio", url: "http://audio.test/a.wav", slot: "recording", durationMs: 4000,
        trimStartMs: 1500, pieceOf: A, ...(bOffsetMs != null ? { targetOffsetMs: bOffsetMs } : {}),
      },
    },
  } as unknown as CellData
}

describe("planTargetOverlay with a cut take", () => {
  it("fires the first piece, stopping at the cut, and names when the next is due", () => {
    const plan = planTargetOverlay([cutLine()], 0, new Set(), "advance", 10.2, { masterIsExternal: true })
    expect(plan.kind).toBe("fire")
    if (plan.kind !== "fire") return
    expect(plan.audioId).toBe(A)
    expect(plan.stopAtClipSec).toBeCloseTo(1.5)
    expect(plan.nextDueSec).toBeCloseTo(11.5)
  })

  it("fires the SECOND piece once the clock is in it, even while the first's track key still rings", () => {
    const sounding = new Set([overlayKey("a", "recording"), overlayPieceKey("a", "recording", A)])
    const plan = planTargetOverlay([cutLine()], 0, sounding, "advance", 12, { masterIsExternal: true })
    expect(plan.kind).toBe("fire")
    if (plan.kind !== "fire") return
    expect(plan.audioId).toBe(B)
    expect(plan.startAtClipSec).toBeCloseTo(2) // 0.5s into the second piece = 2s into the clip
    expect(plan.nextDueSec).toBeUndefined()
  })

  it("arms a moved second piece at ITS start, and keeps a piece that is already sounding", () => {
    const moved = cutLine(500) // piece B now 12–14.5s
    const gap = planTargetOverlay([moved], 0, new Set(), "advance", 11.7, { masterIsExternal: true })
    expect(gap).toMatchObject({ kind: "arm", dueSec: 12 })
    const ringing = new Set([overlayPieceKey("a", "recording", B)])
    expect(planTargetOverlay([moved], 0, ringing, "advance", 13, { masterIsExternal: true }).kind).toBe("keep")
  })
})
