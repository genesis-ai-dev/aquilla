import { describe, expect, it } from "vitest"
import {
  firstLaneIdFromIdentities,
  homeUnscopedVoices,
  stampNewVoiceLanes,
  stampVoiceLane,
  targetLaneRowId,
} from "./stamp-voice-lane"
import type { Voice } from "@/lib/parsers/types"

const voice = (over: Partial<Voice> & Pick<Voice, "id">): Voice => ({ name: over.id, ...over })

describe("stampVoiceLane", () => {
  it("stamps a new voice and leaves a lane-owned or built-in voice where it is", () => {
    expect(stampVoiceLane(voice({ id: "new" }), "ln-es").laneId).toBe("ln-es")
    const owned = voice({ id: "ar", laneId: "ln-ar" })
    expect(stampVoiceLane(owned, "ln-es")).toBe(owned)
    const narrator = voice({ id: "narrator", builtIn: true })
    expect(stampVoiceLane(narrator, "ln-es")).toBe(narrator)
    const fresh = voice({ id: "new" })
    expect(stampVoiceLane(fresh, null)).toBe(fresh)
  })

  it("stamps only voices the library does not already hold", () => {
    const narrator = voice({ id: "narrator", builtIn: true })
    const made = voice({ id: "made" })
    const next = stampNewVoiceLanes([narrator, made], [narrator], "ln-es")
    expect(next.map((entry) => entry.laneId)).toEqual([undefined, "ln-es"])
  })

  it("puts an unscoped voice on the first lane and leaves the Narrator", () => {
    const narrator = voice({ id: "preset-narrator", builtIn: true })
    const owned = voice({ id: "ar", laneId: "ln-ar" })
    const old = voice({ id: "old" })
    const homed = homeUnscopedVoices([narrator, owned, old], "ln-first")
    expect(homed[0]).toBe(narrator)
    expect(homed[1]).toBe(owned)
    expect(homed[2]?.laneId).toBe("ln-first")
    expect(homeUnscopedVoices([old], null)).toEqual([old])
  })

  it("picks the first non-archived lane", () => {
    expect(firstLaneIdFromIdentities([
      { id: "archived", position: 0, archivedAt: "2026-01-01" },
      { id: "first", position: 1, archivedAt: null },
      { id: "later", position: 2, archivedAt: null },
    ])).toBe("first")
  })

  it("resolves one target lane row for a legacy tag", () => {
    const lanes = [
      { id: "src", role: "source", legacyTag: null },
      { id: "ln-es", role: "target", legacyTag: "es" },
    ]
    expect(targetLaneRowId(lanes, "es")).toBe("ln-es")
    expect(targetLaneRowId(lanes, "de")).toBeNull()
  })
})
