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

import { saveTranscript } from "./save"

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
