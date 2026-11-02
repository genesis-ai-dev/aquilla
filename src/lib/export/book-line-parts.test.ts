// AQU-1758 (Sam, Oct 29): on a book, a pause someone dragged open — before a
// verse's take, or between two pieces of a cut take — plays as silence in the
// app, so an export that joins a book's takes end to end puts it in as
// silence too, and sounds like playback. `bookLineParts` is a line as
// playback lays it out (the same programme the transport plays).

import { describe, expect, it } from "vitest"
import { bookLineParts } from "./book-line-parts"
import type { CellData } from "@/hooks/useCells"

function verse(id: string, attachments: Record<string, unknown>, over: Partial<CellData> = {}): CellData {
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", context: "", group: `RUT 1:${id.slice(1)}`,
    type: "verse", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    selectedAudioId: Object.keys(attachments)[0],
    attachments: attachments as CellData["attachments"],
    ...over,
  } as CellData
}

const T = "audio-v1-1700000000-take.wav"
const P1 = "audio-v2-1700000000-take.wav"
const P2 = "audio-v2-1700000001-take.wav"

describe("bookLineParts", () => {
  it("a take with a pause dragged open before it: that much silence, then the take", () => {
    const cell = verse("v1", { [T]: { type: "audio", url: `frontier-audio://${T}`, durationMs: 2000, targetOffsetMs: 500 } })
    expect(bookLineParts(cell, T)).toEqual([
      { kind: "silence", ms: 500 },
      { kind: "take", attachmentId: T },
    ])
  })

  it("a take that starts on its line: just the take", () => {
    const cell = verse("v1", { [T]: { type: "audio", url: `frontier-audio://${T}`, durationMs: 2000 } })
    expect(bookLineParts(cell, T)).toEqual([{ kind: "take", attachmentId: T }])
  })

  it("a cut take: the pause before it, each piece, and the silence dragged open between them", () => {
    // Piece 1 is the recording's 0–1.5 s, placed 0.3 s into the line, so it
    // ends at 1.8 s. Piece 2 is its 2–4 s, moved 0.5 s along from there (its
    // place 0.8 s, from the take's 0.3 s): at 2.3 s, 0.5 s of silence.
    const cell = verse("v2", {
      [P1]: { type: "audio", url: `frontier-audio://${P1}`, durationMs: 4000, trimEndMs: 1500, targetOffsetMs: 300 },
      [P2]: { type: "audio", url: `frontier-audio://${P1}`, durationMs: 4000, trimStartMs: 2000, pieceOf: P1, targetOffsetMs: 800 },
    })
    expect(bookLineParts(cell, P1)).toEqual([
      { kind: "silence", ms: 300 },
      { kind: "take", attachmentId: P1 },
      { kind: "silence", ms: 500 },
      { kind: "take", attachmentId: P2 },
    ])
  })

  it("a cut take whose pieces touch: the pieces back to back", () => {
    // As the cut left it: the second piece keeps the take's place.
    const cell = verse("v2", {
      [P1]: { type: "audio", url: `frontier-audio://${P1}`, durationMs: 4000, trimEndMs: 1500 },
      [P2]: { type: "audio", url: `frontier-audio://${P1}`, durationMs: 4000, trimStartMs: 2000, pieceOf: P1 },
    })
    expect(bookLineParts(cell, P1)).toEqual([
      { kind: "take", attachmentId: P1 },
      { kind: "take", attachmentId: P2 },
    ])
  })

  it("is null on a line with times: a timed file's export is not a book's", () => {
    const cell = verse("v1", { [T]: { type: "audio", url: `frontier-audio://${T}`, durationMs: 2000, targetOffsetMs: 500 } }, {
      startTime: 4, endTime: 6,
    })
    expect(bookLineParts(cell, T)).toBeNull()
  })

  it("is null when the take's length is not known, or the export ships another take", () => {
    expect(bookLineParts(verse("v1", { [T]: { type: "audio", url: `frontier-audio://${T}`, targetOffsetMs: 500 } }), T)).toBeNull()
    const cell = verse("v1", { [T]: { type: "audio", url: `frontier-audio://${T}`, durationMs: 2000, targetOffsetMs: 500 } })
    expect(bookLineParts(cell, "audio-v1-1700000099-other.wav")).toBeNull()
  })
})
