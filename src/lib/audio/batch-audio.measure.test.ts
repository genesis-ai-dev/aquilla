// Pre-merge round: the measure-all batch — duration backfill for takes that
// predate duration capture. The important properties:
//   - the imported SOURCE clip (fileId-seeded) never counts as legacy, since
//     its length is the section span by design;
//   - each legacy take gets ONE narrow cell.audio.measure event (never a
//     re-attach, which would re-select the take);
//   - the optimistic paint never claims selection;
//   - bytes that 404 or refuse to decode are counted, not fatal.

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

// audioIdSeededWith matches `-<seed>-` inside the id (buildAudioId embeds the
// seed verbatim), so these fixtures use the real convention.
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

const SOURCE_CLIP = att({ audioId: `aq-${FILE_ID}-clip` })
const LEGACY_TAKE = att({ audioId: "aq-cell-9-take1" })
const MEASURED_TAKE = att({ audioId: "aq-cell-9-take2", durationMs: 2000 })

beforeEach(() => {
  vi.clearAllMocks()
})

describe("attachmentNeedsMeasure", () => {
  it("counts a durationless take, but never the imported source clip", () => {
    expect(attachmentNeedsMeasure(FILE_ID, LEGACY_TAKE)).toBe(true)
    expect(attachmentNeedsMeasure(FILE_ID, SOURCE_CLIP)).toBe(false)
  })

  it("skips takes that already know their length or are still saving", () => {
    expect(attachmentNeedsMeasure(FILE_ID, MEASURED_TAKE)).toBe(false)
    expect(attachmentNeedsMeasure(FILE_ID, { ...LEGACY_TAKE, pendingSync: true })).toBe(false)
  })
})

describe("takesNeedingMeasure", () => {
  it("enumerates every legacy take across cells, and nothing else", () => {
    const byCellId = new Map<string, CellAudioEntry>([
      ["c1", entry(SOURCE_CLIP, LEGACY_TAKE)],
      ["c2", entry(MEASURED_TAKE)],
      ["c3", entry(att({ audioId: "aq-cell-3-gen", slot: "generatedVoice" }))],
    ])
    const targets = takesNeedingMeasure(FILE_ID, byCellId)
    expect(targets.map((t) => t.att.audioId).sort()).toEqual(["aq-cell-3-gen", "aq-cell-9-take1"])
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
      audioId: "aq-cell-9-take1",
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

  it("counts undecodable and missing bytes as failures and keeps going", async () => {
    const other = att({ audioId: "aq-cell-8-take1" })
    probeDurationMsSafe.mockResolvedValueOnce(undefined)
    const result = await runMeasureAll(
      args(new Map([["c1", entry(LEGACY_TAKE)], ["c2", entry(other)]])),
    )
    expect(result.measured + result.failed).toBe(2)
    expect(result.failed).toBe(1)
    expect(emitCellAudioMeasure).toHaveBeenCalledTimes(1)
  })

  it("survives a 404 on one take and still measures the rest", async () => {
    const other = att({ audioId: "aq-cell-8-take1" })
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
