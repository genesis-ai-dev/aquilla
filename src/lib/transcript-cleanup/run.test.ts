// The Transcribe lens's steps report which step failed. transcribeCell never
// throws — it keeps its error in the transcribe-status store — so an ASR
// failure read as "No speech heard" until the run looked there.

import { describe, it, expect, vi, beforeEach } from "vitest"

const transcribeCell = vi.fn()
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: (...args: unknown[]) => transcribeCell(...args) }))
vi.mock("@/lib/posthog", () => ({ default: { scope() { return { ...this, enabled: () => true } }, captureException: vi.fn() } }))
// The save itself is save.test.ts's subject; here it only has to succeed.
vi.mock("./save", () => ({ saveTranscript: vi.fn(async () => true) }))

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

  // ── A run reports as it goes, so the row is never a bare spinner ──────────
  const heardRow = { ...row, heard: "eema akasema", transcript: "eema akasema", cell: {
    ...row.cell, audioTimings: { [audioId]: [{ word: "eema", t0: 0, t1: 1, start: 0, end: 4 }, { word: "akasema", t0: 1, t1: 2, start: 5, end: 12 }] },
  } } as unknown as TranscriptRow
  const sse = (frames: Array<[string, unknown]>) => new Response(
    frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  )
  const json = (result: unknown) => new Response(JSON.stringify({ model: "m", result }), { headers: { "Content-Type": "application/json" } })
  const sentBody = () => JSON.parse(String(fetchSpy.mock.calls[0][1].body)) as Record<string, unknown>

  it("hands over what ASR heard the moment it arrives, before the run has finished", async () => {
    const seen: unknown[] = []
    transcribeCell.mockImplementation(async (args: { onTranscribed: (r: unknown) => void }) => {
      args.onTranscribed({ heard: "eema", transcript: "eema", model: "omni-fast", timings: [{ word: "eema", t0: 0, t1: 1, start: 0, end: 4 }] })
      // Still inside the run: the save is being queued. The row already has it.
      expect(seen).toEqual([{ stage: "listening" }, { stage: "heard", heard: "eema", transcript: "eema" }])
      return 1
    })
    await transcribeRow({ row, project, session, onProgress: (p) => seen.push(p) })
    expect(seen).toHaveLength(2)
  })

  it("hands over the cleanup as it is written, then lands it", async () => {
    fetchSpy.mockResolvedValue(sse([
      ["delta", { add: "Yesu " }],
      ["delta", { add: "akasema" }],
      ["result", { model: "m", result: { kind: "ok", text: "Yesu akasema", notes: [], changes: 1 } }],
    ]))
    const seen: Array<{ stage: string; text?: string }> = []
    const outcome = await transcribeAndCleanUp({
      row: heardRow, rows: [heardRow], project, session, concepts: [], learned: [], onProgress: (p) => seen.push(p),
    })
    expect(sentBody().stream).toBe(true)
    expect(seen.filter((p) => p.stage === "cleaning").map((p) => p.text)).toEqual(["", "Yesu ", "Yesu akasema"])
    expect(outcome).toEqual({ kind: "cleaned", changes: 1, text: "Yesu akasema" })
  })

  // A new project's first rows: no corrected transcript exists yet, so the
  // lines the team has written are the only evidence of the orthography. The
  // line this take READS is never one of them — the cleanup must not be able
  // to "correct" a misreading towards the text.
  it("sends the file's other written lines as spelling evidence, never the line being read", async () => {
    fetchSpy.mockResolvedValue(json({ kind: "unchanged" }))
    const cells = [
      { id: "c0", translated: "Hapo mwanzo Mungu aliumba mbingu." },
      { id: "c1", translated: "Yesu akasema." },
      { id: "c2", translated: "Nayo nchi ilikuwa ukiwa." },
    ] as never
    const outcome = await transcribeAndCleanUp({ row: heardRow, rows: [heardRow], cells, project, session, concepts: [], learned: [] })
    expect(sentBody().samples).toEqual(["Hapo mwanzo Mungu aliumba mbingu.", "Nayo nchi ilikuwa ukiwa."])
    // The model had evidence and still changed nothing: that is a real "nothing to clean up".
    expect(outcome).toEqual({ kind: "unchanged" })
  })

  // With nothing at all to learn from, "nothing to clean up" is a claim the
  // model was in no position to make (Ryder, 2026-11-17: "I can clearly see
  // that the orthography is completely wrong").
  it("reports that it had nothing to learn from, instead of nothing to clean up", async () => {
    fetchSpy.mockResolvedValue(json({ kind: "unchanged" }))
    const outcome = await transcribeAndCleanUp({ row: heardRow, rows: [heardRow], project, session, concepts: [], learned: [] })
    expect(outcome).toEqual({ kind: "unlearned" })
  })

  it("runs the speech model the lens chose, not the one in Preferences", async () => {
    transcribeCell.mockResolvedValue(0)
    await transcribeRow({ row, project, session, speech: { model: "omni-zs", quietFallback: "omni-fast" } })
    expect(transcribeCell.mock.calls[0][0]).toEqual(expect.objectContaining({ hostedModel: "omni-zs", hostedQuietFallback: "omni-fast" }))
  })
})
