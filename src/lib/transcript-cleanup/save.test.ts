// AQU-2254 — which text a saved transcript's word offsets describe.
//
// A save of a source segment also writes the corrected text onto the cell, so
// the offsets have to describe THAT text. A target cell keeps its own text, so
// its offsets are carried over (AQU-1211 reads a shortened cell off them).

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment, WordTiming } from "@/lib/codex-editor/types"

const attaches: Array<Record<string, unknown>> = []
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (input: Record<string, unknown>) => {
    attaches.push(input)
    return "evt-1"
  }),
}))
vi.mock("@/lib/store/transcript-corrections-store", () => ({
  learnFromTranscriptCorrection: vi.fn(),
}))

import { clearTranscript, saveTranscript } from "./save"
import { clearOptimisticShadows, getOptimisticShadows, subscribeAudioAttachments } from "@/lib/audio/audio-attachments-bus"

const attachment = { url: "frontier-audio://a", type: "audio" } as unknown as CodexCellAttachment

/** Timings aligned to "teh house" — the pre-cleanup wording. */
const timings: WordTiming[] = [
  { word: "teh", t0: 0, t1: 0.4, start: 0, end: 3 },
  { word: "house", t0: 0.4, t1: 0.9, start: 4, end: 9 },
]

/** A media cell whose SELECTED clip is the file's imported source clip
 *  (seeded with the file id) — a transcription-mode row. */
function sourceSegment(): CellData {
  return {
    id: "c1",
    fileId: "f1",
    medium: "media",
    selectedAudioId: "audio-f1-1700000000-abc",
  } as unknown as CellData
}

/** A media cell whose selected clip is a take of its own (seeded with the
 *  cell id) — the transcript is the take's, not the line's text. */
function ownTake(): CellData {
  return {
    id: "c1",
    fileId: "f1",
    medium: "media",
    selectedAudioId: "audio-c1-1700000000-abc",
  } as unknown as CellData
}

async function save(owner: CellData, text: string) {
  attaches.length = 0
  const ok = await saveTranscript({
    projectId: "p1",
    owner,
    audioId: owner.selectedAudioId!,
    attachment,
    timings,
    text,
    author: "u",
    ai: { model: "m", at: 0, changes: 1 },
  })
  expect(ok).toBe(true)
  return attaches[0] as { timings: WordTiming[]; transcription?: string }
}

beforeEach(() => {
  attaches.length = 0
})

describe("saveTranscript word offsets", () => {
  it("re-offsets onto the cleaned text it writes onto a source segment", async () => {
    const attach = await save(sourceSegment(), "the household")
    expect(attach.transcription).toBe("the household")
    expect(attach.timings).toEqual([
      { word: "the", t0: 0, t1: 0.4, start: 0, end: 3 },
      { word: "household", t0: 0.4, t1: 0.9, start: 4, end: 13 },
    ])
  })

  it("re-offsets when the cleanup shortens the words too", async () => {
    const attach = await save(sourceSegment(), "a hut")
    expect(attach.timings).toEqual([
      { word: "a", t0: 0, t1: 0.4, start: 0, end: 1 },
      { word: "hut", t0: 0.4, t1: 0.9, start: 2, end: 5 },
    ])
  })

  it("carries the cell's own offsets over when it does not write the text", async () => {
    const attach = await save(ownTake(), "the household")
    expect(attach.transcription).toBeUndefined()
    expect(attach.timings).toEqual([
      { word: "the", t0: 0, t1: 0.4, start: 0, end: 3 },
      { word: "household", t0: 0.4, t1: 0.9, start: 4, end: 9 },
    ])
  })
})

// AQU-2491 (review, Nov 9): a transcript is words about a take. Saving one (a
// correction in the takes list, an AI cleanup that finishes after the line was
// re-recorded) or clearing one must not make that take the chosen one, or
// bring it back if it was deleted meanwhile.
describe("a transcript write chooses nothing (AQU-2491)", () => {
  it("a saved transcript rides a words-only re-attach", async () => {
    const attach = await save(ownTake(), "the household")
    expect(attach).toMatchObject({ audioId: "audio-c1-1700000000-abc", wordsOnly: true })
  })

  it("so does a cleared one", async () => {
    attaches.length = 0
    const owner = ownTake()
    await clearTranscript({ projectId: "p1", owner, audioId: owner.selectedAudioId!, attachment, author: "u" })
    expect(attaches[0]).toMatchObject({ timings: [], wordsOnly: true })
  })
})

// AQU-2654: a save used to be seen only after the outbox was flushed and the
// whole file's audio read back. The write itself now tells the audio read what
// changed on the one take, bound to the event that carries it.
describe("a transcript write is shown from the write itself (AQU-2654)", () => {
  const shadowsOf = () => getOptimisticShadows("f1").get("c1") ?? []

  beforeEach(() => {
    clearOptimisticShadows("f1")
  })

  it("hands the take's new words to the file's audio read, bound to the queued event", async () => {
    const seen: string[] = []
    const stop = subscribeAudioAttachments("f1", () => seen.push("re-read"))
    const attach = await save(ownTake(), "the household")
    stop()
    expect(shadowsOf()).toMatchObject([{
      kind: "words", audioId: "audio-c1-1700000000-abc", eventId: "evt-1", phase: "queued",
      words: { timings: attach.timings, transcriptAi: { model: "m", at: 0, changes: 1 } },
    }])
    // Nothing asked for the file to be read again.
    expect(seen).toEqual([])
  })

  it("a human correction takes the AI mark off, as the server does", async () => {
    const owner = ownTake()
    await saveTranscript({ projectId: "p1", owner, audioId: owner.selectedAudioId!, attachment, timings, text: "the house", author: "u" })
    expect(shadowsOf()).toMatchObject([{ kind: "words", words: { transcriptAi: null } }])
    expect(shadowsOf()[0]).not.toHaveProperty("words.asrText")
  })

  it("a clear empties what was heard and the transcript", async () => {
    const owner = ownTake()
    await clearTranscript({ projectId: "p1", owner, audioId: owner.selectedAudioId!, attachment, author: "u" })
    expect(shadowsOf()).toMatchObject([{ kind: "words", eventId: "evt-1", words: { timings: [], asrText: "", transcriptAi: null } }])
  })

  it("shows nothing when there was nothing to save onto", async () => {
    const owner = ownTake()
    expect(await saveTranscript({ projectId: "p1", owner, audioId: owner.selectedAudioId!, attachment, timings: [], text: "x", author: "u" })).toBe(false)
    expect(shadowsOf()).toEqual([])
  })
})
