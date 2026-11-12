// AQU-2037 — the acceptance criteria for "a voice belongs to the lane it was
// made in", read off the pure rule rather than off the UI that renders it.

import { describe, it, expect } from "vitest"
import {
  laneScopedTtsSettings,
  laneVoiceLibrary,
  resolveLaneVoice,
  stampNewVoiceLanes,
  stampVoiceLane,
  voiceInLane,
  voicesForLane,
} from "./voice-lanes"
import { PRESET_VOICES } from "./voices"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

const LANE_A = "lane-samoan"
const LANE_B = "lane-arabic"

function voice(over: Partial<Voice> = {}): Voice {
  return { id: "v-1", name: "Voice", color: "#475569", ...over }
}

const narrator = PRESET_VOICES[0]
const samoan = voice({ id: "v-sam", name: "Samoan reader", laneId: LANE_A })
const arabic = voice({ id: "v-ara", name: "LITTLE MARY MAGDALENE.", laneId: LANE_B, language: "ar" })
/** A voice stored before this ticket: no lane, so every lane still offers it. */
const legacy = voice({ id: "v-old", name: "Pre-2037" })

function settings(over: Partial<ProjectTtsSettings> = {}): ProjectTtsSettings {
  return { voices: [narrator, samoan, arabic], defaultVoiceId: narrator.id, ...over }
}

describe("voiceInLane", () => {
  it("offers a voice on its own lane and nowhere else", () => {
    expect(voiceInLane(samoan, LANE_A)).toBe(true)
    expect(voiceInLane(samoan, LANE_B)).toBe(false)
  })

  it("offers a lane-less voice on every lane — nothing disappears before AQU-2039", () => {
    expect(voiceInLane(legacy, LANE_A)).toBe(true)
    expect(voiceInLane(legacy, LANE_B)).toBe(true)
  })

  it("scopes nothing when no lane is in view", () => {
    expect(voiceInLane(arabic, null)).toBe(true)
    expect(voiceInLane(arabic, undefined)).toBe(true)
    expect(voiceInLane(arabic, "")).toBe(true)
  })
})

describe("voicesForLane", () => {
  it("keeps the lane's voices plus the unmigrated ones, in library order", () => {
    expect(voicesForLane([narrator, samoan, arabic, legacy], LANE_B))
      .toEqual([narrator, arabic, legacy])
  })

  it("returns the whole list unfiltered with no lane", () => {
    expect(voicesForLane([samoan, arabic], null)).toEqual([samoan, arabic])
  })
})

describe("laneVoiceLibrary", () => {
  it("lists only the active lane's voices", () => {
    expect(laneVoiceLibrary(settings(), LANE_A).map((v) => v.id)).toEqual([narrator.id, samoan.id])
    expect(laneVoiceLibrary(settings(), LANE_B).map((v) => v.id)).toEqual([narrator.id, arabic.id])
  })

  it("gives a lane with no voices of its own just the built-in Narrator", () => {
    const onlyOtherLanes = settings({ voices: [samoan, arabic] })
    expect(laneVoiceLibrary(onlyOtherLanes, "lane-new")).toEqual([...PRESET_VOICES])
  })

  it("still shows a pre-2037 library on every lane", () => {
    const unmigrated = settings({ voices: [legacy, voice({ id: "v-old2", name: "Also old" })] })
    expect(laneVoiceLibrary(unmigrated, LANE_A).map((v) => v.id)).toEqual(["v-old", "v-old2"])
    expect(laneVoiceLibrary(unmigrated, LANE_B).map((v) => v.id)).toEqual(["v-old", "v-old2"])
  })

  it("is the plain library when there is no lane (single-lane projects unchanged)", () => {
    expect(laneVoiceLibrary(settings(), null).map((v) => v.id))
      .toEqual([narrator.id, samoan.id, arabic.id])
  })
})

describe("resolveLaneVoice", () => {
  it("honours the cell's voice on the lane that owns it", () => {
    expect(resolveLaneVoice(settings(), samoan.id, LANE_A).id).toBe(samoan.id)
  })

  it("treats a cell cast to another lane's voice as unassigned — the reported Arabic-speaks-Samoan case", () => {
    expect(resolveLaneVoice(settings(), arabic.id, LANE_A).id).toBe(narrator.id)
  })

  it("falls back to the built-in Narrator when the starred default belongs to another lane", () => {
    const starredOnA = settings({ defaultVoiceId: samoan.id })
    expect(resolveLaneVoice(starredOnA, undefined, LANE_B).id).toBe(narrator.id)
    expect(resolveLaneVoice(starredOnA, undefined, LANE_A).id).toBe(samoan.id)
  })

  it("uses the lane's first voice when the lane has no built-in to fall back to", () => {
    const noPreset = settings({ voices: [samoan, arabic], defaultVoiceId: samoan.id })
    expect(resolveLaneVoice(noPreset, undefined, LANE_B).id).toBe(arabic.id)
  })

  it("resolves exactly as before when there is no lane", () => {
    expect(resolveLaneVoice(settings(), arabic.id, null).id).toBe(arabic.id)
  })
})

describe("laneScopedTtsSettings", () => {
  it("narrows the library and resolves the lane's default", () => {
    const scoped = laneScopedTtsSettings(settings({ defaultVoiceId: samoan.id }), LANE_B)
    expect(scoped?.voices?.map((v) => v.id)).toEqual([narrator.id, arabic.id])
    expect(scoped?.defaultVoiceId).toBe(narrator.id)
  })

  it("drops cast assignments pointing at another lane's voice", () => {
    const scoped = laneScopedTtsSettings(
      settings({ castAssignments: { "cell-1": arabic.id, "cell-2": samoan.id } }),
      LANE_A,
    )
    expect(scoped?.castAssignments).toEqual({ "cell-2": samoan.id })
  })

  it("does not invent a castAssignments key for a project that has none", () => {
    expect(laneScopedTtsSettings(settings(), LANE_A)).not.toHaveProperty("castAssignments")
  })

  it("carries every other setting through untouched", () => {
    const scoped = laneScopedTtsSettings(settings({ provider: "gemini", apiKey: "k" }), LANE_A)
    expect(scoped?.provider).toBe("gemini")
    expect(scoped?.apiKey).toBe("k")
  })

  it("is the input itself when there is no lane to scope to", () => {
    const whole = settings()
    expect(laneScopedTtsSettings(whole, null)).toBe(whole)
    expect(laneScopedTtsSettings(undefined, LANE_A)).toBeUndefined()
  })
})

describe("stampVoiceLane", () => {
  it("puts a fresh voice in the active lane", () => {
    expect(stampVoiceLane(voice({ id: "v-new" }), LANE_A).laneId).toBe(LANE_A)
  })

  it("never moves a voice that already names a lane", () => {
    expect(stampVoiceLane(arabic, LANE_A)).toBe(arabic)
  })

  it("never stamps a built-in preset — every lane falls back to the Narrator", () => {
    expect(stampVoiceLane(narrator, LANE_A)).toBe(narrator)
  })

  it("leaves the voice alone when there is no lane", () => {
    const fresh = voice({ id: "v-new" })
    expect(stampVoiceLane(fresh, null)).toBe(fresh)
  })
})

describe("stampNewVoiceLanes", () => {
  it("stamps only the voices the stored library does not already hold", () => {
    const made = voice({ id: "v-new", name: "New voice" })
    const next = stampNewVoiceLanes([narrator, samoan, arabic, made], [narrator, samoan, arabic], LANE_A)
    expect(next.map((v) => [v.id, v.laneId])).toEqual([
      [narrator.id, undefined],
      [samoan.id, LANE_A],
      [arabic.id, LANE_B],
      ["v-new", LANE_A],
    ])
  })

  it("leaves an edited voice on its own lane, whichever lane the editor is on", () => {
    const renamed = { ...arabic, name: "Renamed" }
    const [kept] = stampNewVoiceLanes([renamed], [arabic], LANE_A)
    expect(kept.laneId).toBe(LANE_B)
  })

  it("leaves a pre-2037 voice lane-less when it is edited", () => {
    const renamed = { ...legacy, name: "Renamed" }
    const [kept] = stampNewVoiceLanes([renamed], [legacy], LANE_A)
    expect(kept.laneId).toBeUndefined()
  })

  it("stamps the first voice a project ever stores, but not the seeded Narrator", () => {
    const made = voice({ id: "v-new" })
    const next = stampNewVoiceLanes([narrator, made], undefined, LANE_A)
    expect(next.map((v) => v.laneId)).toEqual([undefined, LANE_A])
  })

  it("stamps nothing when the project has no target lane rows", () => {
    const made = voice({ id: "v-new" })
    expect(stampNewVoiceLanes([made], undefined, null)).toEqual([made])
  })
})
