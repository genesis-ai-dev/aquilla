import { describe, it, expect } from "vitest"
import { clearLaneCast, LANE_CAST_DEFAULT, laneTtsSettings, setLaneCast, setLaneDefaultVoice } from "./lane-cast"
import { resolveCastVoice, assignedCastVoiceId } from "./voices"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

const SAMOAN = "sm"
const ARABIC = "ar"

function voice(id: string, name = id): Voice {
  return { id, name, color: "#475569" }
}

function settings(over: Partial<ProjectTtsSettings> = {}): ProjectTtsSettings {
  return { voices: [voice("v-sm"), voice("v-ar"), voice("v-old")], ...over }
}

describe("laneTtsSettings", () => {
  it("is the same object while no lane has a cast or default of its own", () => {
    // The guarantee every pre-AQU-2038 project (and every single-lane project)
    // leans on: nothing about the read changes, down to object identity.
    const s = settings({ castAssignments: { c1: "v-old" }, defaultVoiceId: "v-old" })
    expect(laneTtsSettings(s, "")).toBe(s)
    expect(laneTtsSettings(s, SAMOAN)).toBe(s)
    expect(laneTtsSettings(undefined, SAMOAN)).toBeUndefined()
  })

  it("gives each lane its own assignment for the same cell", () => {
    const s = settings({
      laneCastAssignments: { [SAMOAN]: { c1: "v-sm" }, [ARABIC]: { c1: "v-ar" } },
    })
    expect(resolveCastVoice(laneTtsSettings(s, SAMOAN), "c1").id).toBe("v-sm")
    expect(resolveCastVoice(laneTtsSettings(s, ARABIC), "c1").id).toBe("v-ar")
  })

  it("keeps the pre-lane project-wide assignment on a lane that has none", () => {
    const s = settings({
      castAssignments: { c1: "v-old", c2: "v-old" },
      laneCastAssignments: { [SAMOAN]: { c1: "v-sm" } },
    })
    // Samoan overrode c1 only; c2 — and all of Arabic — still generate as before.
    expect(assignedCastVoiceId(laneTtsSettings(s, SAMOAN), "c1")).toBe("v-sm")
    expect(assignedCastVoiceId(laneTtsSettings(s, SAMOAN), "c2")).toBe("v-old")
    expect(assignedCastVoiceId(laneTtsSettings(s, ARABIC), "c1")).toBe("v-old")
  })

  it("lets a lane go back to its default over a project-wide assignment", () => {
    const s = settings({
      castAssignments: { c1: "v-old" },
      laneCastAssignments: { [SAMOAN]: { c1: LANE_CAST_DEFAULT } },
      laneDefaultVoiceId: { [SAMOAN]: "v-sm" },
    })
    expect(assignedCastVoiceId(laneTtsSettings(s, SAMOAN), "c1")).toBeUndefined()
    expect(resolveCastVoice(laneTtsSettings(s, SAMOAN), "c1").id).toBe("v-sm")
    // ...and the other lane never noticed.
    expect(assignedCastVoiceId(laneTtsSettings(s, ARABIC), "c1")).toBe("v-old")
  })

  it("drops a project-wide assignment the lane cannot see", () => {
    // The visibility proviso: once the library is lane-owned (AQU-2037), an
    // inherited assignment naming a voice this lane has no access to is not an
    // assignment at all.
    const s = settings({
      voices: [voice("v-sm")],
      castAssignments: { c1: "v-gone" },
      laneCastAssignments: { [SAMOAN]: {} },
    })
    expect(assignedCastVoiceId(laneTtsSettings(s, SAMOAN), "c1")).toBeUndefined()
  })

  it("stars a default per lane and inherits the project-wide one otherwise", () => {
    const s = settings({
      defaultVoiceId: "v-old",
      laneDefaultVoiceId: { [SAMOAN]: "v-sm" },
    })
    expect(laneTtsSettings(s, SAMOAN)?.defaultVoiceId).toBe("v-sm")
    expect(laneTtsSettings(s, ARABIC)?.defaultVoiceId).toBe("v-old")
  })

  it("falls back to the library's first voice where a lane has no default of its own", () => {
    const s = settings({
      defaultVoiceId: "v-old",
      laneDefaultVoiceId: { [SAMOAN]: LANE_CAST_DEFAULT },
    })
    const projected = laneTtsSettings(s, SAMOAN)
    expect(projected?.defaultVoiceId).toBeUndefined()
    expect(resolveCastVoice(projected, "c1").id).toBe("v-sm")
  })

  it("does not invent a cast map for a project that has never had one", () => {
    // `prunePhantomVoices` reads the absence of `castAssignments` as "the
    // Studio was never opened" — the projection must not fabricate one.
    const s = settings({ laneDefaultVoiceId: { [SAMOAN]: "v-sm" } })
    expect(laneTtsSettings(s, SAMOAN)).not.toHaveProperty("castAssignments")
  })
})

describe("setLaneCast", () => {
  it("writes only the named lane's key", () => {
    const s = settings({
      castAssignments: { c1: "v-old" },
      laneCastAssignments: { [ARABIC]: { c1: "v-ar" } },
    })
    const patch = setLaneCast(s, SAMOAN, ["c1", "c2"], "v-sm")
    expect(patch.laneCastAssignments).toEqual({
      [ARABIC]: { c1: "v-ar" },
      [SAMOAN]: { c1: "v-sm", c2: "v-sm" },
    })
    // The pre-lane fallback is never rewritten by one lane's casting.
    expect(s.castAssignments).toEqual({ c1: "v-old" })
  })

  it("records 'back to default' rather than deleting the entry", () => {
    const s = settings({ laneCastAssignments: { [SAMOAN]: { c1: "v-sm" } } })
    expect(setLaneCast(s, SAMOAN, ["c1"], null).laneCastAssignments)
      .toEqual({ [SAMOAN]: { c1: LANE_CAST_DEFAULT } })
  })
})

describe("setLaneDefaultVoice", () => {
  it("stars a voice for one lane only", () => {
    const s = settings({ defaultVoiceId: "v-old", laneDefaultVoiceId: { [ARABIC]: "v-ar" } })
    expect(setLaneDefaultVoice(s, SAMOAN, "v-sm").laneDefaultVoiceId)
      .toEqual({ [ARABIC]: "v-ar", [SAMOAN]: "v-sm" })
    expect(s.defaultVoiceId).toBe("v-old")
  })

  it("records that a lane has no default, so the project-wide one can't take the star back", () => {
    expect(setLaneDefaultVoice(settings(), SAMOAN, undefined).laneDefaultVoiceId)
      .toEqual({ [SAMOAN]: LANE_CAST_DEFAULT })
  })
})

describe("clearLaneCast", () => {
  it("drops the cells from every lane, since the character is shared", () => {
    const s = settings({
      laneCastAssignments: { [SAMOAN]: { c1: "v-sm", c2: "v-sm" }, [ARABIC]: { c1: "v-ar" } },
    })
    expect(clearLaneCast(s, ["c1"])).toEqual({
      laneCastAssignments: { [SAMOAN]: { c2: "v-sm" }, [ARABIC]: {} },
    })
  })

  it("writes nothing for a project with no lane cast at all", () => {
    expect(clearLaneCast(settings({ castAssignments: { c1: "v-old" } }), ["c1"])).toEqual({})
  })
})
