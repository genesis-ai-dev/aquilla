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

import {
  piecesFromCuts, shareTextByWordTimes, splitRecordingLine, textsForPieces, textsForSplit, writeLineWords, type RecordingLine,
} from "./split-recording-line"

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
    // AQU-2426 (review, Nov 9): its words ride a words-only re-attach that
    // names no role, so the takes already chosen on the line stay chosen.
    expect(calls[2].input).toMatchObject({ cellId: "c1", audioId: "f-clip.m4a", slot: "recording", transcription: "A.", wordsOnly: true })
    expect(calls[2].input.role).toBeUndefined()
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

describe("piecesFromCuts with words", () => {
  it("a dropped cut hands its words to the piece before", () => {
    const pieces = piecesFromCuts(whole, [10_000, 10_050], ["One.", "Two.", "Three."])
    expect(pieces.map((p) => p.text)).toEqual(["One.", "Two. Three."])
  })
})

describe("words kept on a whole line, shared out by a later split", () => {
  // Words from a words run nobody split by, seconds from the stretch's start.
  const kept = [
    { text: "In", start: 0.5, end: 0.8 }, { text: "the", start: 0.9, end: 1.0 }, { text: "beginning.", start: 1.1, end: 1.6 },
    { text: "Ruth", start: 12.0, end: 12.4 }, { text: "went.", start: 12.5, end: 13.0 },
    { text: "Naomi", start: 30.2, end: 30.8 }, { text: "wept.", start: 31.0, end: 31.5 },
  ]

  it("each piece gets the words whose middle falls in its stretch; a piece with none gets none", () => {
    const pieces = piecesFromCuts(whole, [10_000, 20_000, 28_000])
    expect(textsForPieces(pieces, 0, kept)).toEqual(["In the beginning.", "Ruth went.", "", "Naomi wept."])
  })

  it("counts from the stretch's start on the recording", () => {
    const line = { ...whole, trimStartMs: 5_000, trimEndMs: 45_000 }
    const pieces = piecesFromCuts(line, [15_000])
    // "Ruth" at 12 s from the stretch's start is 17 s on the recording: the second piece.
    expect(textsForPieces(pieces, 5_000, kept)).toEqual(["In the beginning.", "Ruth went. Naomi wept."])
  })

  it("an empty first piece clears the words the whole line kept", async () => {
    const pieces = piecesFromCuts(whole, [10_000]).map((p, i) => ({ ...p, text: i === 0 ? "" : "Ruth went." }))
    await splitRecordingLine({ line: whole, pieces, author: "lee", mintId: () => "n1" })
    expect(calls.find((c) => c.kind === "attach" && c.input.cellId === "c1")?.input).toMatchObject({ transcription: "" })
  })
})


describe("writeLineWords (AQU-2426 review, Nov 9)", () => {
  it("puts words on a line without claiming its recording slot", async () => {
    await writeLineWords({ line: whole, text: "The whole transcript.", author: "lee" })
    expect(calls.map((c) => c.kind)).toEqual(["attach"])
    expect(calls[0].input).toMatchObject({
      projectId: "p", fileId: "f", cellId: "c1", audioId: "f-clip.m4a", url: whole.url, slot: "recording",
      transcription: "The whole transcript.", wordsOnly: true, author: "lee",
    })
    expect(calls[0].input.role).toBeUndefined()
  })
})

// AQU-2426 (review, Nov 9): a split with no words of its own (At pauses) on a
// line that already has its text. The whole transcript used to stay on the
// first new line unless a words run was still kept in this browser.
describe("a line's own text, shared out by word times", () => {
  // Seconds from the stretch's start, as a transcript's stored timings are.
  const timed = [
    { text: "In", start: 0.5, end: 0.8 }, { text: "the", start: 0.9, end: 1.0 }, { text: "beginning.", start: 1.1, end: 1.6 },
    { text: "Ruth", start: 12.0, end: 12.4 }, { text: "went.", start: 12.5, end: 13.0 },
    { text: "Naomi", start: 30.2, end: 30.8 }, { text: "wept.", start: 31.0, end: 31.5 },
  ]
  const pieces = piecesFromCuts(whole, [10_000, 20_000, 28_000])

  it("each line gets its own stretch of the text; a line with no words gets none", () => {
    expect(shareTextByWordTimes(pieces, 0, "In the beginning. Ruth went. Naomi wept.", timed))
      .toEqual(["In the beginning.", "Ruth went.", "", "Naomi wept."])
  })

  it("keeps what someone corrected, in the line it belongs to", () => {
    expect(shareTextByWordTimes(pieces, 0, "In the beginning: Ruth left. Naomi wept!", timed))
      .toEqual(["In the beginning:", "Ruth left.", "", "Naomi wept!"])
  })

  it("still finds each line's start after words were added or taken out", () => {
    expect(shareTextByWordTimes(pieces, 0, "Long ago, in the beginning. Ruth went away. Naomi wept.", timed))
      .toEqual(["Long ago, in the beginning.", "Ruth went away.", "", "Naomi wept."])
    expect(shareTextByWordTimes(pieces, 0, "The beginning. Ruth went. Naomi wept.", timed))
      .toEqual(["The beginning.", "Ruth went.", "", "Naomi wept."])
  })

  it("never loses or repeats a word, whatever the edit", () => {
    const text = "Completely different words were typed here by someone later on."
    const shared = shareTextByWordTimes(pieces, 0, text, timed)
    if (shared) expect(shared.filter(Boolean).join(" ")).toBe(text)
  })

  it("can't be done with no word times, or for no text", () => {
    expect(shareTextByWordTimes(pieces, 0, "In the beginning.", [])).toBeNull()
    expect(shareTextByWordTimes(pieces, 0, "  ", timed)).toBeNull()
  })

  it("counts from the stretch's start on the recording", () => {
    const line = { ...whole, trimStartMs: 5_000, trimEndMs: 45_000 }
    expect(shareTextByWordTimes(piecesFromCuts(line, [15_000]), 5_000, "In the beginning. Ruth went. Naomi wept.", timed))
      .toEqual(["In the beginning.", "Ruth went. Naomi wept."])
  })
})

describe("textsForSplit: where a split at pauses gets each line's text", () => {
  const timed = [
    { text: "In", start: 0.5, end: 0.8 }, { text: "the", start: 0.9, end: 1.0 }, { text: "beginning.", start: 1.1, end: 1.6 },
    { text: "Ruth", start: 12.0, end: 12.4 }, { text: "went.", start: 12.5, end: 13.0 },
  ]
  const pieces = piecesFromCuts(whole, [10_000])
  const stored = timed.map((w) => ({ word: w.text, t0: w.start, t1: w.end, start: 0, end: 0 }))

  it("the text came from Transcribe all (no kept words run): shared out by its stored word times", () => {
    expect(textsForSplit({ pieces, lo: 0, lineText: "In the beginning. Ruth went.", kept: null, timings: stored }))
      .toEqual({ texts: ["In the beginning.", "Ruth went."], stayed: false })
  })

  it("a kept words run, and the line's text is still its words: each line gets its words", () => {
    expect(textsForSplit({ pieces, lo: 0, lineText: "In the beginning. Ruth went.", kept: { words: timed, text: "In the beginning. Ruth went." }, timings: undefined }))
      .toEqual({ texts: ["In the beginning.", "Ruth went."], stayed: false })
    // The words never reached the line (Import and transcribe…, then Undo).
    expect(textsForSplit({ pieces, lo: 0, lineText: "", kept: { words: timed, text: "In the beginning. Ruth went." }, timings: undefined }))
      .toEqual({ texts: ["In the beginning.", "Ruth went."], stayed: false })
  })

  it("a kept words run, but the text was corrected since: the corrections win", () => {
    expect(textsForSplit({ pieces, lo: 0, lineText: "In the beginning. Ruth left.", kept: { words: timed, text: "In the beginning. Ruth went." }, timings: undefined }))
      .toEqual({ texts: ["In the beginning.", "Ruth left."], stayed: false })
  })

  it("text with no word times at all stays on the first line, and that is known", () => {
    expect(textsForSplit({ pieces, lo: 0, lineText: "Typed by hand.", kept: null, timings: [] })).toEqual({ texts: null, stayed: true })
  })

  it("no text: nothing to share and nothing stayed", () => {
    expect(textsForSplit({ pieces, lo: 0, lineText: "", kept: null, timings: undefined })).toEqual({ texts: null, stayed: false })
  })
})

// AQU-2426 (review, Nov 9): lines made from a words run got their text but no
// word timings (no word-by-word highlight while playing) and no record of
// what the transcription heard (nothing for the cleanup step to learn from),
// unlike lines transcribed with Transcribe all.
describe("lines split by their words keep the words' times and what was heard", () => {
  const heard = {
    model: "whisper-large-v3",
    // Seconds from the line's start; "Ruth" was corrected from what was heard.
    words: [
      { text: "In", start: 0.5, end: 0.8 }, { text: "the", start: 0.9, end: 1.0 }, { text: "beginning.", start: 1.1, end: 1.6 },
      { text: "Ruth", start: 12.0, end: 12.4, heard: "Root" }, { text: "went.", start: 12.5, end: 13.0 },
    ],
  }

  it("each line's words are timed from its own start, and say what was heard", async () => {
    const pieces = piecesFromCuts(whole, [10_000], ["In the beginning.", "Ruth went."])
    await splitRecordingLine({ line: whole, pieces, author: "lee", mintId: () => "n1", heard })
    const first = calls.find((c) => c.kind === "attach" && c.input.cellId === "c1")!.input
    expect(first).toMatchObject({
      wordsOnly: true,
      transcription: "In the beginning.",
      timings: [
        { word: "In", t0: 0.5, t1: 0.8, start: 0, end: 2 },
        { word: "the", t0: 0.9, t1: 1.0, start: 3, end: 6 },
        { word: "beginning.", t0: 1.1, t1: 1.6, start: 7, end: 17 },
      ],
      asr: { text: "In the beginning.", model: "whisper-large-v3" },
    })
    const second = calls.find((c) => c.kind === "attach" && c.input.cellId === "n1")!.input
    // 12.0 s into the line is 2.0 s into a line that starts at 10 s.
    expect((second.timings as Array<{ word: string; t0: number }>).map((w) => [w.word, Math.round(w.t0 * 10) / 10]))
      .toEqual([["Ruth", 2], ["went.", 2.5]])
    expect(second.asr).toEqual({ text: "Root went.", model: "whisper-large-v3" })
  })

  it("a first line left with no words loses the whole recording's old timings", async () => {
    const pieces = piecesFromCuts(whole, [5_000], ["", "In the beginning. Ruth went."])
    await splitRecordingLine({ line: whole, pieces: pieces.map((p, i) => ({ ...p, text: i === 0 ? "" : p.text })), author: "lee", mintId: () => "n1", heard: { words: heard.words.map((w) => ({ ...w, start: w.start + 6, end: w.end + 6 })) } })
    const first = calls.find((c) => c.kind === "attach" && c.input.cellId === "c1")!.input
    expect(first.timings).toEqual([])
    // Word times with no model behind them (a transcript's stored timings) are not "what was heard".
    expect(first.asr).toBeUndefined()
    expect(calls.find((c) => c.kind === "attach" && c.input.cellId === "n1")!.input.asr).toBeUndefined()
  })

  it("a whole line that keeps its words gets them timed too", async () => {
    await writeLineWords({ line: whole, text: "In the beginning. Ruth went.", author: "lee", heard })
    expect((calls[0].input.timings as unknown[]).length).toBe(5)
    expect(calls[0].input.asr).toEqual({ text: "In the beginning. Root went.", model: "whisper-large-v3" })
  })
})
