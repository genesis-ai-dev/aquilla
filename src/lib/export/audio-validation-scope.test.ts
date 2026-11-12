// AQU-965: the audio export's validated-only scope, and the count the Export
// dialog shows before anything is written.
import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import {
  isSilencedForExport,
  scopeAudioCellsForExport,
  shippingDubTakes,
  unvalidatedAudioLineIds,
} from "./audio-validation-scope"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "verse", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const take = (over: Partial<CodexCellAttachment> = {}): CodexCellAttachment => ({
  url: "frontier-audio://a.wav",
  type: "audio/wav",
  slot: "recording",
  ...over,
})

/** A line with one recorded take on the default track, carrying `votes`. */
const line = (id: string, votes: number, over: Partial<CellData> = {}): CellData =>
  cell({
    id,
    selectedAudioId: `a-${id}`,
    attachments: { [`a-${id}`]: take({ url: `frontier-audio://a-${id}.wav`, validatorCount: votes }) },
    ...over,
  })

const silencedIds = (cells: CellData[]): string[] =>
  cells
    .flatMap((c) => Object.entries(c.attachments ?? {}))
    .filter(([, att]) => isSilencedForExport(att))
    .map(([audioId]) => audioId)

describe("shippingDubTakes", () => {
  it("takes the selected take of every track, default and added", () => {
    const c = line("v1", 1, {
      selectedBySlot: { recording: "a-v1", "track-es": "a-es" },
      attachments: {
        "a-v1": take({ url: "frontier-audio://a-v1.wav", validatorCount: 1 }),
        "a-es": take({ url: "frontier-audio://a-es.wav", slot: "track-es", validatorCount: 0 }),
      },
    })
    expect(shippingDubTakes(c).map((t) => t.audioId).sort()).toEqual(["a-es", "a-v1"])
  })

  it("leaves out imported programme audio, which is not somebody's take", () => {
    const c = cell({
      id: "m1",
      selectedAudioId: "src-1",
      attachments: { "src-1": take({ url: "frontier-audio://src-1.wav", role: "source" }) },
    })
    expect(shippingDubTakes(c)).toEqual([])
  })

  it("leaves out a selected take with no url — no export would write it", () => {
    const c = cell({
      id: "v1",
      selectedAudioId: "a-v1",
      attachments: { "a-v1": take({ url: "" }) },
    })
    expect(shippingDubTakes(c)).toEqual([])
  })

  it("reads the generated voice only when no recording is selected", () => {
    const c = cell({
      id: "v1",
      selectedGeneratedVoiceAudioId: "g-1",
      attachments: { "g-1": take({ url: "frontier-audio://g-1.wav", slot: "generatedVoice", voiceId: "v" }) },
    })
    expect(shippingDubTakes(c).map((t) => t.audioId)).toEqual(["g-1"])
  })
})

describe("unvalidatedAudioLineIds", () => {
  it("counts a line whose shipping take is short of the project's threshold", () => {
    const cells = [line("v1", 2), line("v2", 1), line("v3", 0)]
    expect(unvalidatedAudioLineIds(cells, 2)).toEqual(["v2", "v3"])
    expect(unvalidatedAudioLineIds(cells, 1)).toEqual(["v3"])
  })

  it("counts a validated line whose SECOND track is unvalidated", () => {
    // The gutter reads the weakest take, because two tracks sound together.
    const c = line("v1", 3, {
      selectedBySlot: { recording: "a-v1", "track-es": "a-es" },
      attachments: {
        "a-v1": take({ url: "frontier-audio://a-v1.wav", validatorCount: 3 }),
        "a-es": take({ url: "frontier-audio://a-es.wav", slot: "track-es", validatorCount: 0 }),
      },
    })
    expect(unvalidatedAudioLineIds([c], 1)).toEqual(["v1"])
  })

  it("does not count a line with nothing recorded — it ships no audio", () => {
    expect(unvalidatedAudioLineIds([cell({ id: "v1" }), line("v2", 1)], 1)).toEqual([])
  })

  it("applies the one-vote floor a threshold of zero still implies", () => {
    expect(unvalidatedAudioLineIds([line("v1", 0)], 0)).toEqual(["v1"])
  })
})

describe("scopeAudioCellsForExport", () => {
  it("returns the caller's own array under 'current' — today's exports are untouched", () => {
    const cells = [line("v1", 0), line("v2", 1)]
    expect(scopeAudioCellsForExport(cells, "current", 1)).toBe(cells)
  })

  it("returns the caller's own array when every take is validated", () => {
    const cells = [line("v1", 1), line("v2", 2)]
    expect(scopeAudioCellsForExport(cells, "validated-only", 1)).toBe(cells)
  })

  it("withdraws only the takes short of the threshold", () => {
    const scoped = scopeAudioCellsForExport([line("v1", 2), line("v2", 0)], "validated-only", 2)
    expect(silencedIds(scoped)).toEqual(["a-v2"])
  })

  it("withdraws the unvalidated track of a line and leaves its validated one", () => {
    const c = line("v1", 2, {
      selectedBySlot: { recording: "a-v1", "track-es": "a-es" },
      attachments: {
        "a-v1": take({ url: "frontier-audio://a-v1.wav", validatorCount: 2 }),
        "a-es": take({ url: "frontier-audio://a-es.wav", slot: "track-es", validatorCount: 0 }),
      },
    })
    expect(silencedIds(scopeAudioCellsForExport([c], "validated-only", 1))).toEqual(["a-es"])
  })

  it("never mutates the caller's cells — the previews read them next", () => {
    const cells = [line("v1", 0)]
    scopeAudioCellsForExport(cells, "validated-only", 1)
    expect(silencedIds(cells)).toEqual([])
  })

  it("keeps the withdrawn take's url, duration and trim window for the chapter gap", () => {
    const c = line("v1", 0, {
      attachments: {
        "a-v1": take({
          url: "frontier-audio://a-v1.wav",
          validatorCount: 0,
          durationMs: 1500,
          trimStartMs: 250,
          trimEndMs: 1000,
        }),
      },
    })
    const [scoped] = scopeAudioCellsForExport([c], "validated-only", 1)
    expect(scoped.attachments?.["a-v1"]).toMatchObject({
      url: "frontier-audio://a-v1.wav",
      durationMs: 1500,
      trimStartMs: 250,
      trimEndMs: 1000,
      silencedForExport: true,
    })
  })

  it("leaves imported programme audio alone, however few votes it carries", () => {
    const c = cell({
      id: "m1",
      selectedAudioId: "src-1",
      attachments: { "src-1": take({ url: "frontier-audio://src-1.wav", role: "source" }) },
    })
    expect(scopeAudioCellsForExport([c], "validated-only", 1)).toEqual([c])
  })
})
