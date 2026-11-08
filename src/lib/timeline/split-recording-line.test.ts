import { beforeEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ kind: string; input: Record<string, unknown> }> = []
vi.mock("@/lib/sync/events-emit", () => {
  const record = (kind: string) => async (input: Record<string, unknown>) => {
    calls.push({ kind, input })
    return `ev-${calls.length}`
  }
  return {
    emitCellRetime: record("retime"),
    emitCellAudioTrim: record("trim"),
    emitCellAudioAttach: record("attach"),
    emitSourceCellCreate: record("create"),
    emitSourceCellReorder: record("reorder"),
  }
})

import { piecesFromCuts, splitRecordingLine, type RecordingLine } from "./split-recording-line"

const whole: RecordingLine = {
  projectId: "p", fileId: "f", cellId: "c1", name: "Ruth 1 intro.m4a",
  startMs: 0, endMs: 40_000, audioId: "f-clip.m4a", url: "frontier-audio://p/f/f-clip.m4a",
  durationMs: 40_000, sequenceIndex: 0,
}

beforeEach(() => { calls.length = 0 })

describe("piecesFromCuts (AQU-2426)", () => {
  it("tiles a whole recording at its cuts", () => {
    const pieces = piecesFromCuts(whole, [10_000, 25_000])
    expect(pieces.map((p) => [p.startMs, p.endMs, p.trimStartMs, p.trimEndMs])).toEqual([
      [0, 10_000, 0, 10_000], [10_000, 25_000, 10_000, 25_000], [25_000, 40_000, 25_000, 40_000],
    ])
  })

  it("maps a piece of a longer recording onto its own place on the timeline", () => {
    const piece = { startMs: 60_000, endMs: 90_000, trimStartMs: 120_000, trimEndMs: 150_000 }
    expect(piecesFromCuts(piece, [130_000]).map((p) => [p.startMs, p.endMs, p.trimStartMs, p.trimEndMs])).toEqual([
      [60_000, 70_000, 120_000, 130_000], [70_000, 90_000, 130_000, 150_000],
    ])
  })

  it("drops cuts outside the stretch or too close together", () => {
    expect(piecesFromCuts(whole, [50, 10_000, 10_100, 39_950, 50_000]).length).toBe(2)
  })

  it("carries each piece's words", () => {
    expect(piecesFromCuts(whole, [20_000], ["One.", "Two."]).map((p) => p.text)).toEqual(["One.", "Two."])
  })
})

describe("splitRecordingLine", () => {
  it("keeps the line as the first piece and makes the rest after it", async () => {
    let n = 0
    const result = await splitRecordingLine({
      line: { ...whole, successor: { cellId: "c2", eventId: "e2", sequenceIndex: 1 } },
      pieces: piecesFromCuts(whole, [10_000, 25_000], ["A.", "B.", "C."]),
      author: "lee",
      mintId: () => `new${++n}`,
    })
    expect(result?.created.map((c) => c.cellId)).toEqual(["new1", "new2"])
    expect(result?.before).toEqual({ startMs: 0, endMs: 40_000, trimStartMs: null, trimEndMs: null })
    const kinds = calls.map((c) => c.kind)
    expect(kinds).toEqual(["retime", "trim", "attach", "create", "attach", "create", "attach", "reorder"])
    // The first piece is the line itself, narrowed.
    expect(calls[0].input).toMatchObject({ cellId: "c1", startMs: 0, endMs: 10_000 })
    expect(calls[1].input).toMatchObject({ cellId: "c1", trimStartMs: 0, trimEndMs: 10_000 })
    expect(calls[2].input).toMatchObject({ cellId: "c1", transcription: "A.", role: "source" })
    // New lines share the recording, each with its own window, chained in order.
    expect(calls[3].input).toMatchObject({ cellId: "new1", anchorCellId: "c1", medium: "media", startMs: 10_000, endMs: 25_000, transcription: "B." })
    expect(calls[4].input).toMatchObject({ cellId: "new1", audioId: "f-clip.m4a", trimStartMs: 10_000, trimEndMs: 25_000, role: "source", slot: "recording" })
    expect(calls[5].input).toMatchObject({ cellId: "new2", anchorCellId: "new1" })
    // The line after is re-pointed at the last piece.
    expect(calls[7].input).toMatchObject({ cellId: "c2", parentId: "e2", anchorCellId: "new2" })
    // Sequence indexes fall between the line and the one after it.
    expect(calls[3].input.sequenceIndex).toBeCloseTo(1 / 3)
    expect(calls[5].input.sequenceIndex).toBeCloseTo(2 / 3)
  })

  it("writes nothing for a single piece", async () => {
    expect(await splitRecordingLine({ line: whole, pieces: piecesFromCuts(whole, []), author: "lee" })).toBeNull()
    expect(calls).toEqual([])
  })
})
