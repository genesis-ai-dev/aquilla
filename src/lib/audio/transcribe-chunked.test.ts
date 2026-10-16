import { describe, expect, it, vi } from "vitest"

vi.mock("./transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))

import {
  assignWordsToRows,
  CHUNK_MAX_GAP_MS,
  planTranscriptionChunks,
  transcribeChunk,
  type TranscriptionChunk,
} from "./transcribe-chunked"
import type { TranscriptionResult } from "./transcribe"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

// AQU-1681. WHY: hosted transcription allows each person 60 requests per 15
// minutes. One request per row meant an episode cut into ~900 rows got 60 of
// them transcribed and the rest refused. Sam's ruling: send about a minute per
// request, cut at row boundaries, and hand each word back to the row it was
// spoken in — exactly the text a row would have got on its own, timed from
// the start of the row.

const CLIP = "audio-file1-1792105301290-7brtt9hly"

/** A row of the shared recording `CLIP`, its stretch in ms. */
function row(id: string, startMs: number, endMs: number, over: Partial<CellData> = {}): CellData {
  const audioId = `${CLIP}`
  return {
    id, fileId: "file1", medium: "media", selectedAudioId: audioId,
    attachments: { [audioId]: { url: `frontier-audio://${CLIP}.m4a`, trimStartMs: startMs, trimEndMs: endMs } },
    ...over,
  } as unknown as CellData
}

const all = () => true

describe("planTranscriptionChunks", () => {
  it("packs consecutive rows into minutes, never splitting a row", () => {
    // Twelve 8-second rows, 2 s apart: six fit in a minute (a seventh would end at 68 s).
    const rows = Array.from({ length: 12 }, (_, i) => row(`r${i}`, i * 10_000, i * 10_000 + 8_000))
    const { chunks, single } = planTranscriptionChunks(rows, all)
    expect(single).toEqual([])
    expect(chunks.map((c) => [c.startMs, c.endMs, c.rows.length])).toEqual([[0, 58_000, 6], [60_000, 118_000, 6]])
    expect(chunks.every((c) => c.endMs - c.startMs <= 60_000)).toBe(true)
    expect(chunks[0]!.clipKey).toBe(`${CLIP}.m4a`)
  })

  it("sends a row longer than a minute on its own", () => {
    const rows = [row("a", 0, 3_000), row("long", 4_000, 70_000), row("b", 71_000, 74_000), row("c", 75_000, 78_000)]
    const { chunks, single } = planTranscriptionChunks(rows, all)
    expect(single.map((c) => c.id)).toEqual(["a", "long"])
    expect(chunks.map((c) => c.rows.map((r) => r.cell.id))).toEqual([["b", "c"]])
  })

  it("never stretches a minute across a row that already has its text", () => {
    const rows = [row("a", 0, 3_000), row("done", 4_000, 7_000), row("b", 8_000, 11_000), row("c", 12_000, 15_000)]
    const { chunks, single } = planTranscriptionChunks(rows, (c) => c.id !== "done")
    expect(chunks.map((c) => c.rows.map((r) => r.cell.id))).toEqual([["b", "c"]])
    expect(single.map((c) => c.id)).toEqual(["a"])
  })

  it("ends a minute at a long stretch nobody needs transcribed", () => {
    const rows = [row("a", 0, 3_000), row("b", 4_000, 7_000), row("c", 7_000 + CHUNK_MAX_GAP_MS + 1, 20_000), row("d", 21_000, 24_000)]
    const { chunks } = planTranscriptionChunks(rows, all)
    expect(chunks.map((c) => c.rows.map((r) => r.cell.id))).toEqual([["a", "b"], ["c", "d"]])
  })

  it("leaves takes and rows with no stretch to the row-by-row path", () => {
    const take = row("take", 0, 3_000, { selectedAudioId: "audio-take-123-abc" } as Partial<CellData>)
    ;(take as unknown as { attachments: Record<string, unknown> }).attachments["audio-take-123-abc"] = { url: "frontier-audio://audio-take-123-abc.webm" }
    const untimed = row("untimed", 0, 0)
    const { chunks, single } = planTranscriptionChunks([take, untimed], all)
    expect(chunks).toEqual([])
    expect(single.map((c) => c.id)).toEqual(["take", "untimed"])
  })
})

/** A minute at 100 s holding rows 100–103 s and 104–107.5 s. */
function chunkOf(): TranscriptionChunk {
  const a = row("a", 100_000, 103_000)
  const b = row("b", 104_000, 107_500)
  return { clipKey: `${CLIP}.m4a`, startMs: 100_000, endMs: 107_500, rows: [
    { cell: a, startMs: 100_000, endMs: 103_000 },
    { cell: b, startMs: 104_000, endMs: 107_500 },
  ] }
}

describe("assignWordsToRows", () => {
  it("gives each row the words spoken in its stretch, punctuation included, timed from the row's start", () => {
    const result: TranscriptionResult = {
      text: "Hello there, friend. Where are you going?",
      granularity: "word",
      chunks: [
        { text: "Hello", start: 0.1, end: 0.5 },
        { text: "there,", start: 0.6, end: 1.0 },
        { text: "friend.", start: 1.1, end: 1.6 },
        // In the silence between the rows, nearer the second.
        { text: "Where", start: 3.8, end: 4.1 },
        { text: "are", start: 4.2, end: 4.4 },
        { text: "you", start: 4.5, end: 4.7 },
        { text: "going?", start: 4.8, end: 5.3 },
      ],
    }
    const rows = assignWordsToRows(result, chunkOf())!
    expect(rows.get("a")?.text).toBe("Hello there, friend.")
    expect(rows.get("b")?.text).toBe("Where are you going?")
    expect(rows.get("a")?.chunks[0]).toEqual({ text: "Hello", start: 0.1, end: 0.5 })
    // 100 s + 4.2 s is 0.2 s into row b, which starts at 104 s.
    expect(rows.get("b")?.chunks[1]!.start).toBeCloseTo(0.2, 6)
  })

  it("keeps a language written without spaces as it was written", () => {
    const result: TranscriptionResult = {
      text: "你好世界。我们走吧。",
      chunks: [
        { text: "你好", start: 0.2, end: 0.6 }, { text: "世界。", start: 0.7, end: 1.2 },
        { text: "我们", start: 4.2, end: 4.6 }, { text: "走吧。", start: 4.7, end: 5.2 },
      ],
    }
    const rows = assignWordsToRows(result, chunkOf())!
    expect([rows.get("a")?.text, rows.get("b")?.text]).toEqual(["你好世界。", "我们走吧。"])
  })

  it("joins a row's words when they cannot be found in the transcript", () => {
    const result: TranscriptionResult = {
      text: "something else entirely",
      chunks: [{ text: "one", start: 0.2, end: 0.5 }, { text: "two", start: 4.2, end: 4.5 }, { text: "three", start: 4.6, end: 4.9 }],
    }
    const rows = assignWordsToRows(result, chunkOf())!
    expect([rows.get("a")?.text, rows.get("b")?.text]).toEqual(["one", "two three"])
  })

  it("gives a row with nothing said an empty transcript", () => {
    const rows = assignWordsToRows({ text: "Hi.", chunks: [{ text: "Hi.", start: 0.2, end: 0.5 }] }, chunkOf())!
    expect(rows.get("b")).toEqual({ text: "", chunks: [] })
    expect(assignWordsToRows({ text: "", chunks: [] }, chunkOf())!.get("a")).toEqual({ text: "", chunks: [] })
  })

  it("refuses to guess from sentence-long segments or from text with no timings", () => {
    expect(assignWordsToRows({ text: "Hello there.", granularity: "segment", chunks: [{ text: "Hello there.", start: 0, end: 5 }] }, chunkOf())).toBeNull()
    expect(assignWordsToRows({ text: "Hello there.", chunks: [] }, chunkOf())).toBeNull()
  })
})

describe("transcribeChunk", () => {
  const session = { jwt: "jwt", username: "maint" } as FrontierSession

  it("recognises the minute once and hands each row its share", async () => {
    const recognise = vi.fn(async () => ({
      text: "Hello. Bye.", granularity: "word" as const,
      chunks: [{ text: "Hello.", start: 0.5, end: 1 }, { text: "Bye.", start: 5, end: 5.5 }],
    }))
    const transcribeRow = vi.fn(async (_cell: CellData, _words?: TranscriptionResult) => 1)
    await transcribeChunk(chunkOf(), { session, projectId: "p1", recognise, transcribeRow })
    expect(recognise).toHaveBeenCalledTimes(1)
    expect(transcribeRow.mock.calls.map(([cell, words]) => [cell.id, words?.text]))
      .toEqual([["a", "Hello."], ["b", "Bye."]])
  })

  it("transcribes the minute's rows one by one when the timings are too coarse, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const recognise = vi.fn(async () => ({ text: "Hello. Bye.", granularity: "segment" as const, chunks: [{ text: "Hello. Bye.", start: 0, end: 6 }] }))
    const transcribeRow = vi.fn(async (_cell: CellData, _words?: TranscriptionResult) => 1)
    await transcribeChunk(chunkOf(), { session, projectId: "p1", recognise, transcribeRow })
    expect(transcribeRow.mock.calls.map(([cell, words]) => [cell.id, words])).toEqual([["a", undefined], ["b", undefined]])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("one by one"))
    warn.mockRestore()
  })

  it("marks the minute's rows failed when it cannot be recognised", async () => {
    const { setTranscribeStatus } = await import("./transcribe-status")
    vi.mocked(setTranscribeStatus).mockClear()
    const transcribeRow = vi.fn(async () => 1)
    await transcribeChunk(chunkOf(), {
      session, projectId: "p1", transcribeRow,
      recognise: async () => { throw new Error("Hosted transcription failed (503). Try again.") },
    })
    expect(transcribeRow).not.toHaveBeenCalled()
    expect(vi.mocked(setTranscribeStatus).mock.calls.filter(([, s]) => s.kind === "error")).toHaveLength(2)
  })
})
