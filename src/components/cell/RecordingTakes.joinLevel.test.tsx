// AQU-2494 (browser pass, Nov 12): "Join into one recording" gives the joined
// take what undoing the cut would give it — the take's volume and fades. The
// join reads them off the pieces the Recording tab hands it, and the tab's
// pieces come from the text table's copy of the line (`applyRowOverlays`),
// which left the volume and fades out: the joined take came out flat. This
// runs the whole way the browser does: the audio read, the table's copy, the
// Recording tab, Join, and the attach it sends. (Modelled on AQU-2491's
// RecordingTakes.joinPlace.test.tsx; the review's probe, Nov 12.)
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
  emitCellAudioPlace: vi.fn(async () => "e"), emitCellAudioGain: vi.fn(async () => "e"),
  emitCellAudioValidate: vi.fn(async () => "e"), emitCellAudioUnvalidate: vi.fn(async () => "e"),
  enqueueEvents: vi.fn(async () => []),
}))
vi.mock("@/lib/history/history", () => ({ recordStep: vi.fn(), withGroup: async (_l: unknown, fn: () => Promise<unknown>) => fn() }))
const attached = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock("@/lib/audio/attach-file", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/attach-file")>()),
  attachUploadedTake: vi.fn(async (args: Record<string, unknown>) => { attached.calls.push(args) }),
}))

import { RecordingTakes } from "./RecordingTakes"
import { applyRowOverlays } from "@/components/EditorTable"
import type { CellData } from "@/hooks/useCells"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"

const project = { id: "p1", sourceLanguage: "en", targetLanguage: "es", audioMediaStrategy: "manual", files: [{ id: "f1" }] } as unknown as ProjectRecord
const URL = "frontier-audio://audio-c2-1.webm"
const P1 = "audio-c2-1.webm", P2 = "audio-c2-2.webm"
type Level = { gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null }

/** Line 2 (5 s to 9 s), its 4 s take cut at 1.5 s, each piece holding the
 *  level the read gives it. */
function lineAsTheTableHasIt(first: Level, second: Level): CellData {
  const line = {
    id: "c2", fileId: "f1", original: "", translated: "", context: "", group: "", type: "text",
    status: "unvalidated", validationStatus: "none", activeValidators: [], validationHistory: [],
    history: [], threads: [], medium: "media", startTime: 5, endTime: 9,
  } as unknown as CellData
  const piece = (audioId: string, over: Record<string, unknown>) => ({
    audioId, url: URL, slot: "recording", mimeType: "audio/webm", voiceId: null, referenceAudioId: null,
    durationMs: 4000, trimStartMs: null, trimEndMs: null, ...over,
  })
  const entry = {
    attachments: {
      [P1]: piece(P1, { label: "Take 1 · 1", trimEndMs: 1500, ...first }),
      [P2]: piece(P2, { label: "Take 1 · 2", trimStartMs: 1500, pieceOf: P1, ...second }),
    },
    selectedBySlot: { recording: P1 },
    selectedAudioId: P1,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  } as unknown as CellAudioEntry
  return applyRowOverlays(line, { audioEntry: entry })
}

async function joinFromTheTab(cell: CellData): Promise<Record<string, unknown>> {
  attached.calls.length = 0
  render(
    <RecordingTakes
      project={project} cell={cell} cellText="Hola" editable username="dev"
      session={{ jwt: "j", username: "dev" } as never} onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByTestId("cell-take-join"))
  await waitFor(() => expect(attached.calls).toHaveLength(1))
  return attached.calls[0]
}

describe("Join from the Recording tab hands the pieces' volume and fades on", () => {
  it("a +6 dB take with a 300 ms fade-in and a 500 ms fade-out, cut: the joined take is attached with all three", async () => {
    const call = await joinFromTheTab(lineAsTheTableHasIt(
      { gainDb: 6, fadeInMs: 300, fadeOutMs: null },
      { gainDb: 6, fadeInMs: null, fadeOutMs: 500 },
    ))
    expect(call.level).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 })
  })

  it("a cut stored the old way (the first piece holding all three, the second none): the same", async () => {
    const call = await joinFromTheTab(lineAsTheTableHasIt(
      { gainDb: 6, fadeInMs: 300, fadeOutMs: 500 },
      { gainDb: null, fadeInMs: null, fadeOutMs: null },
    ))
    expect(call.level).toEqual({ gainDb: 6, fadeInMs: 300, fadeOutMs: 500 })
  })
})
