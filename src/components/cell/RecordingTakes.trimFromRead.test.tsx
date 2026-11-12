// AQU-2495 (browser pass, Nov 11): the Recording tab's trim, on a take as the
// text table really hands it: the audio read, then the table's copy of the
// line (`applyRowOverlays`), then the Recording tab. The fix's own test built
// its take by hand, with a place the table's copy did not carry; in the app
// the tab read the take as sitting on its line's start, and let a head-trimmed
// music clip's start be un-trimmed until its sound began before 0:00.
import { beforeEach, describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 20,
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
const emitted = vi.hoisted(() => ({ trims: [] as Array<Record<string, unknown>>, renames: [] as Array<Record<string, unknown>> }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async () => "e"),
  emitCellAudioTrim: vi.fn(async (i: Record<string, unknown>) => { emitted.trims.push(i); return "e-trim" }),
  emitCellAudioSelect: vi.fn(async () => "e"), emitCellAudioDeselect: vi.fn(async () => "e"),
  emitCellAudioRemove: vi.fn(async () => "e"),
  emitCellAudioRename: vi.fn(async (i: Record<string, unknown>) => { emitted.renames.push(i); return "e-rn" }),
  emitCellAudioPlace: vi.fn(async () => "e"),
  emitCellAudioValidate: vi.fn(async () => "e"), emitCellAudioUnvalidate: vi.fn(async () => "e"),
  enqueueEvents: vi.fn(async () => []),
}))
vi.mock("@/lib/history/history", () => ({ recordStep: vi.fn(), withGroup: async (_l: unknown, fn: () => Promise<unknown>) => fn() }))

import { RecordingTakes } from "./RecordingTakes"
import { applyRowOverlays } from "@/components/EditorTable"
import { clearOptimisticShadows, getOptimisticShadows } from "@/lib/audio/audio-attachments-bus"
import type { CellData } from "@/hooks/useCells"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"

const project = { id: "p1", sourceLanguage: "en", targetLanguage: "es", audioMediaStrategy: "manual", files: [{ id: "f1" }] } as unknown as ProjectRecord
const BED = "audio-c2-1700000000-bed.wav"

/** Line 2 (5 s to 9 s) plays a 20 s music bed with its first 3 s trimmed off,
 *  dragged so its sound starts at 0:00: its clip starts 8 s before its line. */
function entry(): CellAudioEntry {
  return {
    attachments: {
      [BED]: {
        audioId: BED, url: `frontier-audio://${BED}`, slot: "recording", mimeType: "audio/wav",
        voiceId: null, referenceAudioId: null, durationMs: 20_000, label: "Music bed",
        trimStartMs: 3_000, trimEndMs: null, targetOffsetMs: -8_000, recordingsOffsetMs: null,
      },
    },
    selectedBySlot: { recording: BED },
    selectedAudioId: BED,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  } as unknown as CellAudioEntry
}
const line = {
  id: "c2", fileId: "f1", original: "", translated: "", context: "", group: "", type: "text",
  status: "unvalidated", validationStatus: "none", activeValidators: [], validationHistory: [],
  history: [], threads: [], medium: "media", startTime: 5, endTime: 9,
} as unknown as CellData

function draw(cell: CellData) {
  return render(
    <RecordingTakes
      project={project} cell={cell} cellText="" editable username="dev"
      session={{ jwt: "j", username: "dev" } as never} onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
    />,
  )
}

/** 400 px for the clip's 20 s: 20 px a second. */
function sized() {
  const root = screen.getByTestId("cell-take-waveform")
  root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 56, width: 400, height: 56, x: 0, y: 0, toJSON: () => ({}) })
}

beforeEach(() => {
  emitted.trims.length = 0
  emitted.renames.length = 0
  clearOptimisticShadows("f1")
})

/** The audio read with the trim's overlay applied, as the app reads it while
 *  the trim is on its way: an overlay of its own fields paints those over the
 *  take as read (Nov 12), any other replaces the take. */
function readWithOverlay(base: CellAudioEntry): CellAudioEntry {
  const shadow = getOptimisticShadows("f1").get("c2")?.find((s) => s.kind === "attach")
  if (!shadow || shadow.kind !== "attach") throw new Error("the trim painted nothing")
  const row = base.attachments[shadow.att.audioId]
  const painted = shadow.only && row ? { ...row, ...Object.fromEntries(shadow.only.map((f) => [f, shadow.att[f]])) } : shadow.att
  return { ...base, attachments: { ...base.attachments, [shadow.att.audioId]: painted } }
}

describe("the Recording tab's trim, on a take as the text table hands it (AQU-2495)", () => {
  it("the start line stops where the clip's sound would start before 0:00", () => {
    draw(applyRowOverlays(line, { audioEntry: entry() }))
    sized()
    const start = screen.getByRole("slider", { name: /start of the kept audio/i })
    // From where it is (3 s, 60 px) back to 1 s: it stays at 3 s, 0:00 in the file.
    fireEvent.pointerDown(start, { clientX: 60, buttons: 1 })
    fireEvent.pointerMove(start, { clientX: 20, buttons: 1 })
    fireEvent.pointerUp(start, { clientX: 20 })
    expect(emitted.trims.map((t) => t.trimStartMs).filter((ms) => (ms as number) < 3_000)).toEqual([])
  })

  // A trim's overlay stands in for the take until the trim is read back. It
  // was a hand-picked copy without the take's name or place: the takes list
  // named the now-nameless take "Take 1" for good (a rename event), and the
  // next trim's floor read the clip as sitting on its line's start.
  it("a trim keeps the take's name and its floor while it is on its way", () => {
    const base = entry()
    base.attachments[BED] = { ...base.attachments[BED], trimStartMs: 4_000, gainDb: -6, fadeOutMs: 800 } as never
    const view = draw(applyRowOverlays(line, { audioEntry: base }))
    sized()
    // From 4 s (80 px) to 3.5 s (70 px): above the floor, so it saves.
    let start = screen.getByRole("slider", { name: /start of the kept audio/i })
    fireEvent.pointerDown(start, { clientX: 80, buttons: 1 })
    fireEvent.pointerMove(start, { clientX: 70, buttons: 1 })
    fireEvent.pointerUp(start, { clientX: 70 })
    expect(emitted.trims.at(-1)).toMatchObject({ audioId: BED, trimStartMs: 3_500 })
    // The tab now shows the take through the trim's overlay.
    const shown = readWithOverlay(base)
    expect(shown.attachments[BED]).toMatchObject({ label: "Music bed", targetOffsetMs: -8_000, gainDb: -6, fadeOutMs: 800 })
    view.rerender(
      <RecordingTakes
        project={project} cell={applyRowOverlays(line, { audioEntry: shown })} cellText="" editable username="dev"
        session={{ jwt: "j", username: "dev" } as never} onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
      />,
    )
    expect(emitted.renames).toEqual([])
    sized()
    start = screen.getByRole("slider", { name: /start of the kept audio/i })
    fireEvent.pointerDown(start, { clientX: 70, buttons: 1 })
    fireEvent.pointerMove(start, { clientX: 20, buttons: 1 })
    fireEvent.pointerUp(start, { clientX: 20 })
    expect(emitted.trims.at(-1)).toMatchObject({ audioId: BED, trimStartMs: 3_000 })
  })
})
