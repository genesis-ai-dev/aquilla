// AQU-2664: what evening out sends — the reading on `cell.audio.measure`
// (both or neither), and the target on its OWN `cell.audio.even`, which never
// carries the take's volume or fades.
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./cqrs-bridge", () => ({ getCqrsOutboxBridge: () => null }))
vi.mock("./outbox", () => ({ enqueueOutboxEvent: vi.fn(async () => {}) }))

import { emitCellAudioEven, emitCellAudioGain, emitCellAudioMeasure } from "./events-emit"
import { enqueueOutboxEvent } from "./outbox"

const mockEnqueue = enqueueOutboxEvent as unknown as ReturnType<typeof vi.fn>
beforeEach(() => mockEnqueue.mockClear())
const last = () => mockEnqueue.mock.calls.at(-1)![0] as { kind: string; payload: Record<string, unknown> }
const where = { projectId: "p1", fileId: "f1", cellId: "c1", audioId: "a1", author: "sam" }

describe("evening out on the wire", () => {
  it("a measure carries the reading beside the duration", async () => {
    await emitCellAudioMeasure({ ...where, durationMs: 4180.6, loudness: { loudnessLufs: -27.4, truePeakDb: -9.2 } })
    expect(last()).toMatchObject({ kind: "cell.audio.measure", payload: { audioId: "a1", durationMs: 4181, loudnessLufs: -27.4, truePeakDb: -9.2 } })
  })

  it("a measure states the window of the recording it measured", async () => {
    await emitCellAudioMeasure({ ...where, durationMs: 900, loudness: { loudnessLufs: -20, truePeakDb: -6, loudnessFromMs: 120.4, loudnessToMs: null } })
    expect(last().payload).toMatchObject({ loudnessFromMs: 120, loudnessToMs: null })
  })

  it("a measure without a reading is the duration backfill it always was", async () => {
    await emitCellAudioMeasure({ ...where, durationMs: 900 })
    expect(last().payload).toEqual({ audioId: "a1", durationMs: 900 })
  })

  it("an even states the target and nothing about the take's volume or fades", async () => {
    await emitCellAudioEven({ ...where, evenTargetLufs: -16 })
    expect(last()).toMatchObject({ kind: "cell.audio.even" })
    expect(last().payload).toEqual({ audioId: "a1", evenTargetLufs: -16 })
    await emitCellAudioEven({ ...where, evenTargetLufs: null })
    expect(last().payload).toEqual({ audioId: "a1", evenTargetLufs: null })
  })

  it("the Station's volume event says nothing about evening out", async () => {
    await emitCellAudioGain({ ...where, gainDb: -3, fadeInMs: 100, fadeOutMs: null })
    expect(Object.keys(last().payload)).not.toContain("evenTargetLufs")
  })
})
