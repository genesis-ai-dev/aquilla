import { describe, it, expect, vi, beforeEach } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

vi.mock("./change-voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./change-voice")>()),
  changeCellVoice: vi.fn(async () => true),
}))

import { changeCellVoice, voiceConversionKey, voiceReferenceFingerprint } from "./change-voice"
import { planChangeVoiceAll, runChangeVoiceAll } from "./change-voice-batch"
import { getBatchProgress } from "./batch-audio"
import { setTtsStatus, ttsStatusKey } from "./tts"

const stock: Voice = { id: "v-stock", name: "Stock", color: "#000", provider: "gemini", voiceName: "Kore", prompt: "{text}" }
/** A ready-made character voice and a trained custom voice — the two kinds Change voice can use. */
const anna: Voice = { id: "v-anna", name: "Anna", color: "#111", libraryVoiceId: "narrator-hearth" }
const ben: Voice = { id: "v-ben", name: "Ben", color: "#222", libraryVoiceId: "c-0a1b2c3d" }

function recorded(id: string): CellData {
  const audioId = `audio-${id}-1-aaaa`
  return {
    id, fileId: "f1", type: "text", translated: "x",
    selectedAudioId: audioId,
    attachments: { [audioId]: { url: "blob:x", type: "audio/webm", slot: "recording" } },
  } as unknown as CellData
}

function convertedFor(id: string, voice: Voice): CellData {
  const base = recorded(id)
  const vcId = `vc-${voiceReferenceFingerprint(voiceConversionKey(voice)!)}-audio-${id}-2-bbbb`
  return {
    ...base,
    selectedAudioId: vcId,
    attachments: {
      ...base.attachments,
      [vcId]: { url: "blob:y", type: "audio/wav", slot: "recording", voiceId: voice.id, referenceAudioId: base.selectedAudioId },
    },
  } as unknown as CellData
}

const settings = {
  voices: [stock, anna, ben],
  defaultVoiceId: "v-stock",
  castAssignments: { c1: "v-anna", c2: "v-ben", c4: "v-anna", c5: "v-anna" },
} as unknown as ProjectTtsSettings

describe("planChangeVoiceAll", () => {
  beforeEach(() => { setTtsStatus(ttsStatusKey("c5"), { kind: "idle" }) })

  it("targets each cell with its own assigned library voice and counts why the rest are skipped", () => {
    const empty = { id: "c6", fileId: "f1", type: "text", attachments: {} } as unknown as CellData
    const plan = planChangeVoiceAll(
      [recorded("c1"), recorded("c2"), recorded("c3"), convertedFor("c4", anna), empty],
      settings,
    )
    expect(plan.targets.map((t) => [t.cell.id, t.voice.id])).toEqual([["c1", "v-anna"], ["c2", "v-ben"]])
    // c3 speaks the stock default: a plain TTS voice has no model to convert into.
    expect(plan.skipped).toEqual({ "no-take": 1, "not-trained": 1, "up-to-date": 1, shared: 0, busy: 0 })
  })

  it("re-targets a converted take when the cell is reassigned to another voice", () => {
    const plan = planChangeVoiceAll([convertedFor("c2", anna)], settings)
    expect(plan.targets.map((t) => t.voice.id)).toEqual(["v-ben"])
  })

  it("leaves a take already in its voice", () => {
    const plan = planChangeVoiceAll([convertedFor("c4", anna)], settings)
    expect(plan.targets).toEqual([])
    expect(plan.skipped["up-to-date"]).toBe(1)
  })

  it("still converts a take whose voice was removed", () => {
    const gone = convertedFor("c4", anna)
    const takeId = gone.selectedAudioId!
    gone.attachments![takeId] = { ...gone.attachments![takeId], voiceId: "v-gone" }
    const plan = planChangeVoiceAll([gone], settings)
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["c4"])
  })

  it("skips a cell that is already voicing", () => {
    setTtsStatus(ttsStatusKey("c5"), { kind: "synthesizing" })
    const plan = planChangeVoiceAll([recorded("c5")], settings)
    expect(plan.targets).toEqual([])
    expect(plan.skipped.busy).toBe(1)
  })
})

// AQU-2499 (review, Nov 9): a chapter uploaded as one file sits on every
// verse over one recording. The run converted the whole chapter once per
// verse, each one paid; such lines are now skipped and counted.
describe("the whole-file run and a recording several lines share", () => {
  const URL = "frontier-audio://audio-c1-1-range.mp3"
  function onRange(id: string, first = false): CellData {
    const audioId = first ? "audio-c1-1-range.mp3" : `audio-${id}-1-range.mp3`
    return {
      id, fileId: "f1", type: "text", translated: "x",
      selectedAudioId: audioId,
      attachments: { [audioId]: { url: URL, type: "audio/mpeg", slot: "recording" } },
    } as unknown as CellData
  }
  function cutTake(id: string): CellData {
    const whole = `audio-${id}-1-cut.webm`
    const url = `frontier-audio://${whole}`
    return {
      id, fileId: "f1", type: "text", translated: "x",
      selectedAudioId: whole,
      attachments: {
        [whole]: { url, type: "audio/webm", slot: "recording", trimEndMs: 1500 },
        [`audio-${id}-2-cut.webm`]: { url, type: "audio/webm", slot: "recording", trimStartMs: 1500, pieceOf: whole },
      },
    } as unknown as CellData
  }

  it("skips every line of the shared recording and counts them", () => {
    const plan = planChangeVoiceAll([onRange("c1", true), onRange("c4"), onRange("c5"), recorded("c2")], settings)
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["c2"])
    expect(plan.skipped.shared).toBe(3)
  })

  it("still converts a cut take's line: its pieces are that one line's recording", () => {
    const plan = planChangeVoiceAll([cutTake("c1"), cutTake("c4")], settings)
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["c1", "c4"])
    expect(plan.skipped.shared).toBe(0)
  })

  it("spends no conversion on them, and reports them rather than failing", async () => {
    vi.mocked(changeCellVoice).mockReset().mockResolvedValue(true)
    const result = await runChangeVoiceAll({
      projectId: "p1", cells: [onRange("c1", true), onRange("c4"), recorded("c2")], settings, session: null, author: "tester",
    })
    expect(vi.mocked(changeCellVoice).mock.calls.map(([a]) => a.cell.id)).toEqual(["c2"])
    expect(result).toMatchObject({ converted: 1, failed: 0 })
    expect(result.skipped.shared).toBe(2)
  })
})

describe("runChangeVoiceAll", () => {
  beforeEach(() => {
    vi.mocked(changeCellVoice).mockReset()
  })

  it("converts every target through changeCellVoice and reports the outcome", async () => {
    vi.mocked(changeCellVoice).mockImplementation(async ({ cell }) => cell.id !== "c2")
    const result = await runChangeVoiceAll({
      projectId: "p1",
      cells: [recorded("c1"), recorded("c2"), recorded("c3")],
      settings,
      session: null,
      author: "tester",
    })
    expect(changeCellVoice).toHaveBeenCalledTimes(2)
    expect(vi.mocked(changeCellVoice).mock.calls.map(([a]) => [a.cell.id, a.voice.id, a.projectId, a.author])).toEqual(
      expect.arrayContaining([["c1", "v-anna", "p1", "tester"], ["c2", "v-ben", "p1", "tester"]]),
    )
    expect(result).toMatchObject({ converted: 1, failed: 1 })
    expect(result.skipped["not-trained"]).toBe(1)
    expect(getBatchProgress()).toBeNull()
  })

  // AQU-2499 (review, Nov 9): a whole-file run in a second language filed
  // every re-voiced take under the default language.
  it("files each re-voiced take in the open language", async () => {
    vi.mocked(changeCellVoice).mockResolvedValue(true)
    await runChangeVoiceAll({
      projectId: "p1", cells: [recorded("c1")], settings, session: null, author: "tester", targetLang: "fr",
    })
    expect(vi.mocked(changeCellVoice).mock.calls[0][0]).toMatchObject({ cell: { id: "c1" }, targetLang: "fr" })
  })

  it("leaves the language off in the default language", async () => {
    vi.mocked(changeCellVoice).mockResolvedValue(true)
    await runChangeVoiceAll({ projectId: "p1", cells: [recorded("c1")], settings, session: null, author: "tester" })
    expect(vi.mocked(changeCellVoice).mock.calls[0][0]).not.toHaveProperty("targetLang")
  })

  it("does nothing, and shows no banner, when no cell qualifies", async () => {
    const result = await runChangeVoiceAll({
      projectId: "p1", cells: [recorded("c3")], settings, session: null, author: "tester",
    })
    expect(changeCellVoice).not.toHaveBeenCalled()
    expect(result.converted).toBe(0)
    expect(getBatchProgress()).toBeNull()
  })
})
