import { describe, it, expect, vi, beforeEach } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

vi.mock("./change-voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./change-voice")>()),
  changeCellVoice: vi.fn(async () => true),
}))

import { changeCellVoice, voiceReferenceFingerprint } from "./change-voice"
import { planChangeVoiceAll, runChangeVoiceAll } from "./change-voice-batch"
import { getBatchProgress } from "./batch-audio"
import { resetChangeVoiceQualityCacheForTests } from "@/lib/store/change-voice-quality"
import { setTtsStatus, ttsStatusKey } from "./tts"

const stock: Voice = { id: "v-stock", name: "Stock", color: "#000", provider: "gemini", voiceName: "Kore", prompt: "{text}" }
const anna: Voice = { ...stock, id: "v-anna", name: "Anna", referenceAudioId: "ref-anna.wav" }
const ben: Voice = { ...stock, id: "v-ben", name: "Ben", referenceAudioId: "ref-ben.wav" }

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
  const vcId = `vc-${voiceReferenceFingerprint(voice.referenceAudioId!)}-audio-${id}-2-bbbb`
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

  it("targets each cell with its own assigned cloned voice and counts why the rest are skipped", () => {
    const empty = { id: "c6", fileId: "f1", type: "text", attachments: {} } as unknown as CellData
    const plan = planChangeVoiceAll(
      [recorded("c1"), recorded("c2"), recorded("c3"), convertedFor("c4", anna), empty],
      settings,
    )
    expect(plan.targets.map((t) => [t.cell.id, t.voice.id])).toEqual([["c1", "v-anna"], ["c2", "v-ben"]])
    expect(plan.skipped).toEqual({ "no-take": 1, "not-cloned": 1, "up-to-date": 1, busy: 0, "voice-reference": 0 })
  })

  it("re-targets a converted take when the cell is reassigned to another clone", () => {
    const plan = planChangeVoiceAll([convertedFor("c2", anna)], settings)
    expect(plan.targets.map((t) => t.voice.id)).toEqual(["v-ben"])
  })

  it("overwrites a conversion when the chosen quality differs", () => {
    const plan = planChangeVoiceAll([convertedFor("c4", anna)], settings, 25)
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["c4"])
    expect(plan.skipped["up-to-date"]).toBe(0)
  })

  it("re-converts when the voice's reference clip changes, even at the same quality", () => {
    const moved = {
      ...settings,
      voices: settings.voices!.map((v) => v.id === "v-anna" ? { ...v, referenceAudioId: "ref-anna-2.wav" } : v),
    }
    // The existing take was named for ref-anna.wav, which counts as Fast (10).
    const plan = planChangeVoiceAll([convertedFor("c4", anna)], moved, 10)
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["c4"])
  })

  it("leaves a take already made from the current clip at the chosen quality", () => {
    const plan = planChangeVoiceAll([convertedFor("c4", anna)], settings, 10)
    expect(plan.targets).toEqual([])
    expect(plan.skipped["up-to-date"]).toBe(1)
  })

  it("leaves a take that a voice is using as its reference clip", () => {
    const using = {
      ...settings,
      voices: settings.voices!.map((v) => v.id === "v-ben" ? { ...v, referenceTakeKey: "c1:recorded" } : v),
    }
    const plan = planChangeVoiceAll([recorded("c1")], using, 25)
    expect(plan.targets).toEqual([])
    expect(plan.skipped["voice-reference"]).toBe(1)
  })

  it("still converts a take whose voice was removed, when no voice uses that take", () => {
    const gone = convertedFor("c4", anna)
    const takeId = gone.selectedAudioId!
    gone.attachments![takeId] = { ...gone.attachments![takeId], voiceId: "v-gone" }
    const plan = planChangeVoiceAll([gone], settings, 25)
    expect(plan.targets.map((t) => t.cell.id)).toEqual(["c4"])
    expect(plan.skipped["voice-reference"]).toBe(0)
  })

  it("skips a cell that is already voicing", () => {
    setTtsStatus(ttsStatusKey("c5"), { kind: "synthesizing" })
    const plan = planChangeVoiceAll([recorded("c5")], settings)
    expect(plan.targets).toEqual([])
    expect(plan.skipped.busy).toBe(1)
  })
})

describe("runChangeVoiceAll", () => {
  beforeEach(() => {
    localStorage.clear()
    resetChangeVoiceQualityCacheForTests()
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
    expect(vi.mocked(changeCellVoice).mock.calls.map(([a]) => [a.cell.id, a.voice.id, a.projectId, a.author, a.diffusionSteps])).toEqual(
      expect.arrayContaining([["c1", "v-anna", "p1", "tester", 25], ["c2", "v-ben", "p1", "tester", 25]]),
    )
    expect(result).toMatchObject({ converted: 1, failed: 1 })
    expect(result.skipped["not-cloned"]).toBe(1)
    expect(getBatchProgress()).toBeNull()
  })

  it("overwrites a finished take when the run asks for a different quality", async () => {
    vi.mocked(changeCellVoice).mockResolvedValue(true)
    const result = await runChangeVoiceAll({
      projectId: "p1",
      cells: [convertedFor("c4", anna)],
      settings,
      session: null,
      author: "tester",
      diffusionSteps: 40,
    })
    expect(changeCellVoice).toHaveBeenCalledTimes(1)
    expect(vi.mocked(changeCellVoice).mock.calls[0][0]).toMatchObject({ diffusionSteps: 40 })
    expect(result.converted).toBe(1)
  })

  it("overwrites a finished take when the voice's reference clip changed", async () => {
    vi.mocked(changeCellVoice).mockResolvedValue(true)
    const moved = {
      ...settings,
      voices: settings.voices!.map((v) => v.id === "v-anna" ? { ...v, referenceAudioId: "ref-anna-2.wav" } : v),
    }
    const result = await runChangeVoiceAll({
      projectId: "p1",
      cells: [convertedFor("c4", anna)],
      settings: moved,
      session: null,
      author: "tester",
      diffusionSteps: 10,
    })
    expect(changeCellVoice).toHaveBeenCalledTimes(1)
    expect(vi.mocked(changeCellVoice).mock.calls[0][0].voice.referenceAudioId).toBe("ref-anna-2.wav")
    expect(result.converted).toBe(1)
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
