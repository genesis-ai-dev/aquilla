// Pre-merge round: the measure-all batch — duration backfill for takes that
// predate duration capture. The properties that matter:
//   - SHARED clips are never measured. Both of them: the imported source clip
//     (fileId-seeded) and the combined "voice together" generation (seeded
//     with the FIRST chosen cell's id and attached to all of them). Their
//     per-cell length comes from trims, and the fill-only projection would
//     make a wrong duration permanent.
//   - each legacy take gets ONE narrow cell.audio.measure event (never a
//     re-attach, which would re-select the take);
//   - the optimistic paint never claims selection, never resurrects a
//     deleted take, and never clobbers a mid-batch edit;
//   - a rejected emit counts as a FAILURE, not a silent success.
//
// Fixture ids follow the real seeding convention (buildAudioId embeds the
// seed as `-<seed>-`), because attachmentNeedsMeasure now depends on it.

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./bytes-cache", () => ({
  audioCacheGet: vi.fn(async () => null),
  audioCachePut: vi.fn(async () => {}),
}))

const fetchCellAudio = vi.fn(async (..._args: unknown[]) => new Uint8Array([1, 2, 3]))
vi.mock("./upload", async (importOriginal) => {
  const real = await importOriginal<typeof import("./upload")>()
  return { ...real, fetchCellAudio: (...args: unknown[]) => fetchCellAudio(...args) }
})

const probeDurationMsSafe = vi.fn(async (..._args: unknown[]): Promise<number | undefined> => 4321.4)
vi.mock("@/lib/import", () => ({
  probeDurationMsSafe: (...args: unknown[]) => probeDurationMsSafe(...args),
}))

const emitCellAudioMeasure = vi.fn(async (..._args: unknown[]) => "evt-measure-1")
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioMeasure: (...args: unknown[]) => emitCellAudioMeasure(...args),
}))

const injectOptimisticAudioAttachment = vi.fn()
const notifyAudioAttachmentsChanged = vi.fn()
vi.mock("./audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: (...args: unknown[]) => injectOptimisticAudioAttachment(...args),
  notifyAudioAttachmentsChanged: (...args: unknown[]) => notifyAudioAttachmentsChanged(...args),
}))

// batch-audio pulls the transcribe/synth graph too — stub it out like
// batch-audio.test.ts does.
vi.mock("./transcribe", () => ({ transcribeCell: vi.fn() }))
vi.mock("./voice-generate-helpers", () => ({ generateCellVoice: vi.fn() }))
vi.mock("./transcribe-status", () => ({ getTranscribeStatus: vi.fn(() => ({ kind: "idle" })) }))
vi.mock("./tts", () => ({ ttsStatusKey: (id: string) => id, getTtsStatus: vi.fn(() => ({ kind: "idle" })) }))

import { attachmentNeedsMeasure, takesNeedingMeasure, runMeasureAll } from "./batch-audio"
import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

const FILE_ID = "file-1"

const att = (o: Partial<AudioAttachmentOut> & { audioId: string }): AudioAttachmentOut => ({
  url: `frontier-audio://${o.audioId}.webm`,
  slot: "recording",
  mimeType: "audio/webm",
  voiceId: null,
  referenceAudioId: null,
  durationMs: null,
  trimStartMs: null,
  trimEndMs: null,
  ...o,
})

const entry = (...atts: AudioAttachmentOut[]): CellAudioEntry => ({
  attachments: Object.fromEntries(atts.map((a) => [a.audioId, a])),
  selectedAudioId: null,
  selectedGeneratedVoiceAudioId: null,
  audioTimings: {},
})

// The imported source clip: seeded with the FILE id, on every media section.
const SOURCE_CLIP = att({ audioId: `audio-${FILE_ID}-1700000000-clip` })
// An ordinary legacy take on c1.
const LEGACY_TAKE = att({ audioId: "audio-c1-1700000000-take1" })
const MEASURED_TAKE = att({ audioId: "audio-c1-1700000000-take2", durationMs: 2000 })
// The combined "voice together" clip: ONE object seeded with the first chosen
// cell's id, attached untrimmed to c1 AND c2.
const COMBINED = att({ audioId: "audio-c1-1700000000-combined", slot: "generatedVoice" })

beforeEach(() => {
  vi.clearAllMocks()
})

describe("attachmentNeedsMeasure", () => {
  const notShared = () => false

  it("counts a durationless take seeded with its own cell", () => {
    expect(attachmentNeedsMeasure(FILE_ID, "c1", LEGACY_TAKE, notShared)).toBe(true)
  })

  it("never counts the imported source clip", () => {
    expect(attachmentNeedsMeasure(FILE_ID, "c1", SOURCE_CLIP, notShared)).toBe(false)
  })

  it("never counts a clip shared across cells, even on the cell that seeded it", () => {
    // The combined "voice together" object: measuring it would write the whole
    // clip's length onto every participating cell, and COALESCE makes that
    // permanent — five chips each drawn across the entire clip.
    const shared = (id: string) => id === COMBINED.audioId
    expect(attachmentNeedsMeasure(FILE_ID, "c1", COMBINED, shared)).toBe(false)
    expect(attachmentNeedsMeasure(FILE_ID, "c2", COMBINED, shared)).toBe(false)
  })

  it("never counts a foreign-seeded clip — an unmeasurable id is left alone", () => {
    // On c2 the combined clip looks like an ordinary take; the seeding test is
    // what catches it. Same guard protects ids predating the convention: a
    // guessed-width chip beats a wrong, unfixable duration.
    expect(attachmentNeedsMeasure(FILE_ID, "c2", COMBINED, notShared)).toBe(false)
  })

  it("skips takes that already know their length or are still saving", () => {
    expect(attachmentNeedsMeasure(FILE_ID, "c1", MEASURED_TAKE, notShared)).toBe(false)
    expect(attachmentNeedsMeasure(FILE_ID, "c1", { ...LEGACY_TAKE, pendingSync: true }, notShared)).toBe(false)
  })
})

describe("takesNeedingMeasure", () => {
  it("enumerates real legacy takes and nothing else", () => {
    const byCellId = new Map<string, CellAudioEntry>([
      ["c1", entry(SOURCE_CLIP, LEGACY_TAKE, COMBINED)],
      ["c2", entry(SOURCE_CLIP, COMBINED, MEASURED_TAKE)],
      ["c3", entry(att({ audioId: "audio-c3-1700000000-gen", slot: "generatedVoice" }))],
    ])
    const targets = takesNeedingMeasure(FILE_ID, byCellId)
    expect(targets.map((t) => `${t.cellId}:${t.att.audioId}`).sort()).toEqual([
      "c1:audio-c1-1700000000-take1",
      "c3:audio-c3-1700000000-gen",
    ])
  })

  it("a one-cell generation is NOT shared, so it is still measurable", () => {
    // "Voice together" on a single cell is just an ordinary generation.
    const solo = att({ audioId: "audio-c1-1700000000-combined", slot: "generatedVoice" })
    const targets = takesNeedingMeasure(FILE_ID, new Map([["c1", entry(solo)]]))
    expect(targets).toHaveLength(1)
  })
})

describe("runMeasureAll", () => {
  const args = (byCellId: Map<string, CellAudioEntry>) => ({
    projectId: "proj-1",
    fileId: FILE_ID,
    byCellId,
    session: null,
    username: "sam",
  })

  it("emits one measure event per legacy take — rounded, never a re-attach", async () => {
    const result = await runMeasureAll(args(new Map([["c1", entry(LEGACY_TAKE)]])))
    expect(result).toEqual({ measured: 1, failed: 0 })
    expect(emitCellAudioMeasure).toHaveBeenCalledTimes(1)
    expect(emitCellAudioMeasure).toHaveBeenCalledWith({
      projectId: "proj-1",
      fileId: FILE_ID,
      cellId: "c1",
      audioId: LEGACY_TAKE.audioId,
      durationMs: 4321,
      author: "sam",
    })
  })

  it("paints the fixed take without claiming selection", async () => {
    await runMeasureAll(args(new Map([["c1", entry(LEGACY_TAKE)]])))
    expect(injectOptimisticAudioAttachment).toHaveBeenCalledTimes(1)
    const [fileId, cellId, painted, , opts] = injectOptimisticAudioAttachment.mock.calls[0]
    expect(fileId).toBe(FILE_ID)
    expect(cellId).toBe("c1")
    expect((painted as AudioAttachmentOut).durationMs).toBe(4321)
    expect(opts).toEqual({ claimSelection: false })
  })

  it("counts a REJECTED emit as a failure — a run that saved nothing must not report success", async () => {
    // Below the event's role floor, enqueueEvent throws. An unawaited emit
    // would have let every take count as measured.
    emitCellAudioMeasure.mockRejectedValueOnce(new Error("insufficient role"))
    const result = await runMeasureAll(args(new Map([["c1", entry(LEGACY_TAKE)]])))
    expect(result).toEqual({ measured: 0, failed: 1 })
    expect(injectOptimisticAudioAttachment).not.toHaveBeenCalled()
  })

  it("counts undecodable and missing bytes as failures and keeps going", async () => {
    const other = att({ audioId: "audio-c2-1700000000-take1" })
    probeDurationMsSafe.mockResolvedValueOnce(undefined)
    const result = await runMeasureAll(
      args(new Map([["c1", entry(LEGACY_TAKE)], ["c2", entry(other)]])),
    )
    expect(result.measured + result.failed).toBe(2)
    expect(result.failed).toBe(1)
    expect(emitCellAudioMeasure).toHaveBeenCalledTimes(1)
  })

  it("survives a 404 on one take and still measures the rest", async () => {
    const other = att({ audioId: "audio-c2-1700000000-take1" })
    fetchCellAudio.mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }))
    const result = await runMeasureAll(
      args(new Map([["c1", entry(LEGACY_TAKE)], ["c2", entry(other)]])),
    )
    expect(result).toEqual({ measured: 1, failed: 1 })
  })

  it("does nothing when there is nothing to measure", async () => {
    const result = await runMeasureAll(args(new Map([["c1", entry(MEASURED_TAKE, SOURCE_CLIP)]])))
    expect(result).toEqual({ measured: 0, failed: 0 })
    expect(fetchCellAudio).not.toHaveBeenCalled()
  })
})
