// AQU-463 — the correction-learning loop across its real boundary: what a
// translator taught the project in the transcript editor (the localStorage
// store) has to reach the transcript that `transcribeCell` persists. A unit
// test of the substitution helpers alone would not have caught the wiring.
import "fake-indexeddb/auto"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { createOpfsFs } from "@/lib/fs/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/fs/__test__/mem-fs-handles"
import { __setRootForTests, audioCachePut } from "./bytes-cache"
import { __resetOpfsAvailabilityForTests } from "@/lib/storage/opfs-availability"
import { transcribeCell, __setTranscribeAudioForTests } from "./transcribe"
import { clearTranscribeStatus } from "./transcribe-status"
import { buildFrontierAudioUrl } from "./upload"
import { learnFromTranscriptCorrection } from "@/lib/store/transcript-corrections-store"
import type { CellData } from "@/hooks/useCells"

vi.mock("./upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload")>()
  return { ...actual, fetchCellAudio: vi.fn() }
})
const emitCellAudioAttach = vi.fn(async (_input: unknown) => "evt-1")
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: (input: unknown) => emitCellAudioAttach(input),
}))

const PROJECT = "proj-463"
const EXT = "webm"

/** An imported media segment: source speech, so its transcript is persisted. */
const SEGMENT_AUDIO_ID = "audio-file-1-100-clip"
const SEGMENT_FULL_ID = `${SEGMENT_AUDIO_ID}.${EXT}`

function mediaCell(): CellData {
  return {
    id: "cell-1",
    original: "", translated: "", fileId: "file-1",
    context: "", group: "", type: "text", status: "unvalidated",
    medium: "media",
    validationStatus: "none", activeValidators: [], validationHistory: [],
    history: [], threads: [],
    selectedAudioId: SEGMENT_FULL_ID,
    attachments: {
      [SEGMENT_FULL_ID]: { type: "audio", url: buildFrontierAudioUrl(SEGMENT_AUDIO_ID, EXT) } as never,
    },
  } as CellData
}

function fakeTranscribe(words: string[]) {
  return vi.fn(async () => ({
    text: words.join(" "),
    chunks: words.map((w, i) => ({ text: w, start: i, end: i + 1 })),
  }))
}

beforeEach(async () => {
  localStorage.clear()
  __resetOpfsAvailabilityForTests()
  __setRootForTests(createOpfsFs(new MemoryDirectoryHandle("root") as unknown as FileSystemDirectoryHandle))
  emitCellAudioAttach.mockClear()
  clearTranscribeStatus(SEGMENT_FULL_ID)
  await audioCachePut(SEGMENT_AUDIO_ID, EXT, new Uint8Array([1, 2, 3]))
})
afterEach(() => { __setTranscribeAudioForTests(null) })

describe("transcribeCell — learned corrections (AQU-463)", () => {
  it("persists the transcript with the project's learned correction already applied", async () => {
    learnFromTranscriptCorrection(PROJECT, "the killy elders met", "the kilisusu elders met")
    __setTranscribeAudioForTests(fakeTranscribe(["Killy", "elders", "sang"]))

    await transcribeCell({ cell: mediaCell(), session: null, projectId: PROJECT })

    expect(emitCellAudioAttach).toHaveBeenCalledWith(
      expect.objectContaining({ transcription: "Kilisusu elders sang" }),
    )
  })

  it("corrects the word timings too, without changing their count or spans", async () => {
    learnFromTranscriptCorrection(PROJECT, "the killy elders met", "the kilisusu elders met")
    __setTranscribeAudioForTests(fakeTranscribe(["Killy", "elders", "sang"]))

    await transcribeCell({ cell: mediaCell(), session: null, projectId: PROJECT })

    const call = emitCellAudioAttach.mock.calls[0][0] as { timings: Array<{ word: string; t0: number; t1: number }> }
    expect(call.timings.map((t) => t.word)).toEqual(["Kilisusu", "elders", "sang"])
    expect(call.timings.map((t) => [t.t0, t.t1])).toEqual([[0, 1], [1, 2], [2, 3]])
  })

  it("leaves the transcript untouched for a project that has learned nothing", async () => {
    learnFromTranscriptCorrection("some-other-project", "the killy elders met", "the kilisusu elders met")
    __setTranscribeAudioForTests(fakeTranscribe(["Killy", "elders", "sang"]))

    await transcribeCell({ cell: mediaCell(), session: null, projectId: PROJECT })

    expect(emitCellAudioAttach).toHaveBeenCalledWith(
      expect.objectContaining({ transcription: "Killy elders sang" }),
    )
  })
})
