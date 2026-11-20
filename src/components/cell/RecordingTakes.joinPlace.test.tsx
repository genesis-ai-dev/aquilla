// AQU-2491 (browser pass, Nov 11): "A re-voiced or joined take keeps the place
// of the take it was made from, so its words land where they did." A take
// placed 0.5 s after its line's start, split, then joined from the Recording
// tab: the joined take sat on the line's start, and Join sent no place. The
// join reads the place from the pieces the tab hands it, and the tab's pieces
// come from the text table's copy of the line (`applyRowOverlays`), which left
// the place out. This runs the whole way the browser does: the audio read, the
// table's copy, the Recording tab, Join, and the attach it sends.
import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 4,
    peaks: null, peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
vi.mock("@/hooks/useRecordingTextDrift", () => ({ useRecordingTextDrift: () => new Map() }))
vi.mock("@/lib/audio/peaks-loader", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/peaks-loader")>()),
  loadPeaksFor: vi.fn(async () => null),
}))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async () => "e"), emitCellAudioTrim: vi.fn(async () => "e"),
  emitCellAudioSelect: vi.fn(async () => "e"), emitCellAudioDeselect: vi.fn(async () => "e"),
  emitCellAudioRemove: vi.fn(async () => "e"), emitCellAudioRename: vi.fn(async () => "e"),
  emitCellAudioPlace: vi.fn(async () => "e"),
  emitCellAudioValidate: vi.fn(async () => "e"), emitCellAudioUnvalidate: vi.fn(async () => "e"),
  enqueueEvents: vi.fn(async () => []),
}))
vi.mock("@/lib/history/history", () => ({ recordStep: vi.fn(), withGroup: async (_l: unknown, fn: () => Promise<unknown>) => fn() }))
const attached = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock("@/lib/audio/attach-file", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/attach-file")>()),
  attachUploadedTake: vi.fn(async (args: Record<string, unknown>) => { attached.calls.push(args) }),
}))

// Merge review, Nov 13: a join of trimmed pieces decodes and uploads their
// sound. Here a "recording" is 1000 samples a second, its bytes its samples.
vi.mock("@/lib/audio/upload", async (orig) => {
  const real = await orig<typeof import("@/lib/audio/upload")>()
  return {
    ...real,
    fetchCellAudio: vi.fn(async () => new Uint8Array(4000)),
    uploadCellAudio: vi.fn(async (a: { audioId: string; ext: string; blob: Blob }) => ({ audioId: a.audioId, ext: a.ext, url: real.buildFrontierAudioUrl(a.audioId, a.ext), sizeBytes: a.blob.size })),
  }
})
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCacheGet: vi.fn(async () => null) }))
vi.mock("@/lib/audio/decode-mono", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/decode-mono")>()),
  TARGET_RATE: 1000,
  decodeToMono48k: vi.fn(async (bytes: Uint8Array) => new Float32Array(bytes.length)),
  concatPcm: (clips: Float32Array[]) => new Float32Array(clips.reduce((n, c) => n + c.length, 0)),
}))
vi.mock("@/lib/audio/wav-encode", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/wav-encode")>()),
  encodeWavPcm16: (samples: Float32Array) => new Blob([new Uint8Array(samples.length)]),
}))

import { RecordingTakes } from "./RecordingTakes"
import { applyRowOverlays } from "@/components/EditorTable"
import type { CellData } from "@/hooks/useCells"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"

const project = { id: "p1", sourceLanguage: "en", targetLanguage: "es", audioMediaStrategy: "manual", files: [{ id: "f1" }] } as unknown as ProjectRecord
const URL = "frontier-audio://audio-c2-1.webm"
const P1 = "audio-c2-1.webm", P2 = "audio-c2-2.webm"

/** Line 2 (5 s to 9 s), its 4 s take placed 0.5 s after the line's start and
 *  cut at 1.5 s: both pieces keep the take's place, as the server stores them. */
function lineAsTheTableHasIt(
  place: { targetOffsetMs: number | null; recordingsOffsetMs: number | null } = { targetOffsetMs: 500, recordingsOffsetMs: null },
  /** Merge review, Nov 13: the take's start trimmed off this far, and the track it is on. */
  opts: { headMs?: number; slot?: string } = {},
): CellData {
  const line = {
    id: "c2", fileId: "f1", original: "", translated: "", context: "", group: "", type: "text",
    status: "unvalidated", validationStatus: "none", activeValidators: [], validationHistory: [],
    history: [], threads: [], medium: "media", startTime: 5, endTime: 9,
  } as unknown as CellData
  const slot = opts.slot ?? "recording"
  const piece = (audioId: string, over: Record<string, unknown>) => ({
    audioId, url: URL, slot, mimeType: "audio/webm", voiceId: null, referenceAudioId: null,
    durationMs: 4000, trimStartMs: null, trimEndMs: null, ...place, ...over,
  })
  const entry = {
    attachments: {
      [P1]: piece(P1, { label: "Take 1 · 1", trimEndMs: 1500, ...(opts.headMs ? { trimStartMs: opts.headMs } : {}) }),
      [P2]: piece(P2, { label: "Take 1 · 2", trimStartMs: 1500, pieceOf: P1 }),
    },
    selectedBySlot: { [slot]: P1 },
    selectedAudioId: slot === "recording" ? P1 : null,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  } as unknown as CellAudioEntry
  return applyRowOverlays(line, { audioEntry: entry })
}

describe("Join from the Recording tab keeps the place of the take it was made from (AQU-2491)", () => {
  it("the joined take is attached at the take's own place, 0.5 s after its line's start", async () => {
    attached.calls.length = 0
    render(
      <RecordingTakes
        project={project} cell={lineAsTheTableHasIt()} cellText="Hola" editable username="dev"
        session={{ jwt: "j", username: "dev" } as never} onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("cell-take-join"))
    await waitFor(() => expect(attached.calls).toHaveLength(1))
    expect(attached.calls[0]).toMatchObject({ cellId: "c2", url: URL, place: { targetOffsetMs: 500, recordingsOffsetMs: null } })
  })

  // Following the recordings a take's place is its own pause before its line
  // (`recordingsOffsetMs`), which the joined take keeps the same way.
  it("following the recordings, the joined take keeps the take's pause before its line", async () => {
    attached.calls.length = 0
    render(
      <RecordingTakes
        project={project} cell={lineAsTheTableHasIt({ targetOffsetMs: null, recordingsOffsetMs: 700 })} cellText="Hola" editable username="dev"
        session={{ jwt: "j", username: "dev" } as never} onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("cell-take-join"))
    await waitFor(() => expect(attached.calls).toHaveLength(1))
    expect(attached.calls[0]).toMatchObject({ cellId: "c2", place: { targetOffsetMs: null, recordingsOffsetMs: 700 } })
  })

  // Merge review, Nov 13 (MUST 1): with its first piece's start trimmed off,
  // the joined recording starts where that piece's sound did, so its place
  // following the source is that much later: the piece's clip sat 0.5 s into
  // its line with 1 s trimmed off, and sounded from 1.5 s in. Following the
  // recordings a main-track take sounds from its place, which stays where the
  // piece read it (0.5 s, now the joined take's own).
  it("with its first piece's start trimmed off: the joined take sounds where that piece did", async () => {
    attached.calls.length = 0
    render(
      <RecordingTakes
        project={project} cell={lineAsTheTableHasIt(undefined, { headMs: 1000 })} cellText="Hola" editable username="dev"
        session={{ jwt: "j", username: "dev" } as never} onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("cell-take-join"))
    await waitFor(() => expect(attached.calls).toHaveLength(1))
    expect(attached.calls[0]).toMatchObject({ cellId: "c2", durationMs: 3000, place: { targetOffsetMs: 1500, recordingsOffsetMs: 500 } })
  })

  // …and on a track made a layer, following the recordings its clip is placed
  // as following the source: with no place of its own there, it reads that
  // one, which already moved.
  it("on a track made a layer: the joined take sounds where that piece did, in both timings", async () => {
    attached.calls.length = 0
    const TRACK = "01a17e67-ef58-74f7-a093-be935876197b"
    const withLayer = { ...project, files: [{ id: "f1", trackOverrides: { [TRACK]: { kind: "audio", name: "Music", setsLineLengths: false } } }] } as unknown as ProjectRecord
    render(
      <RecordingTakes
        project={withLayer} cell={lineAsTheTableHasIt({ targetOffsetMs: 500, recordingsOffsetMs: 300 }, { headMs: 1000, slot: TRACK })} cellText="Hola" editable username="dev"
        session={{ jwt: "j", username: "dev" } as never} onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("cell-take-join"))
    await waitFor(() => expect(attached.calls).toHaveLength(1))
    expect(attached.calls[0]).toMatchObject({ cellId: "c2", slot: TRACK, place: { targetOffsetMs: 1500, recordingsOffsetMs: 1300 } })
  })
})
