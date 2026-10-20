import { describe, expect, it } from "vitest"
import { stampNewVoiceLanes, stampVoiceLane, targetLaneRowId } from "./stamp-voice-lane"
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

  it("resolves one target lane row for a legacy tag", () => {
    const lanes = [
      { id: "src", role: "source", legacyTag: null },
      { id: "ln-es", role: "target", legacyTag: "es" },
    ]
    expect(targetLaneRowId(lanes, "es")).toBe("ln-es")
    expect(targetLaneRowId(lanes, "de")).toBeNull()
  })
})
