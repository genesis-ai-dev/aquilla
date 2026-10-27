// The Transcribe lens's steps report which step failed. transcribeCell never
// throws — it keeps its error in the transcribe-status store — so an ASR
// failure read as "No speech heard" until the run looked there.

import { describe, it, expect, vi, beforeEach } from "vitest"

const transcribeCell = vi.fn()
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: (...args: unknown[]) => transcribeCell(...args) }))
vi.mock("@/lib/posthog", () => ({ default: { captureException: vi.fn() } }))

import { setTranscribeStatus } from "@/lib/audio/transcribe-status"
import { transcribeAndCleanUp, transcribeRow } from "./run"
import type { TranscriptRow } from "./rows"
import type { ProjectRecord } from "@/lib/parsers/types"

const project = { id: "p1", lanes: [] } as unknown as ProjectRecord
const session = { jwt: "j", username: "u" } as never
const audioId = "audio-c1-1700000000-take.webm"
const row = {
  cell: {
    id: "c1", fileId: "f1", selectedAudioId: audioId,
    attachments: { [audioId]: { url: `frontier-audio://${audioId}`, slot: "recording" } },
    audioTimings: {},
  },
  audioId, isSourceSegment: false, heard: null, transcript: "", aiCleaned: false, validated: false,
} as unknown as TranscriptRow

const fetchSpy = vi.fn()

beforeEach(() => {
  transcribeCell.mockReset()
  fetchSpy.mockReset()
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  setTranscribeStatus(audioId, { kind: "idle" })
})

describe("Transcribe lens steps", () => {
  it("names a failed ASR step with its reason, and never sends it on to the cleanup", async () => {
    transcribeCell.mockImplementation(async () => {
      setTranscribeStatus(audioId, { kind: "error", message: "Hosted transcription model unavailable (502)." })
      return 0
    })
    const outcome = await transcribeAndCleanUp({ row, rows: [row], project, session, concepts: [], learned: [] })
    expect(outcome).toEqual({ kind: "failed", step: "asr", detail: "Hosted transcription model unavailable (502)." })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("transcribes a row without any cleanup request", async () => {
    transcribeCell.mockImplementation(async (args: { onTranscribed: (r: unknown) => void }) => {
      args.onTranscribed({ heard: "eema", transcript: "eema", model: "omni-ctc", timings: [{ word: "eema", t0: 0, t1: 1, start: 0, end: 4 }] })
      return 1
    })
    expect(await transcribeRow({ row, project, session })).toEqual({ kind: "transcribed" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
