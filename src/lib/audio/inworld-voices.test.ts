import { describe, expect, it } from "vitest"
import { projectTargetLaneLanguages, showVoiceLanguageBadge } from "./inworld-voices"

describe("projectTargetLaneLanguages", () => {
  it("includes the default target plus extra active lanes", () => {
    expect(projectTargetLaneLanguages({
      targetLanguage: "en",
      targetLanes: ["es", "fr-CA"],
    })).toEqual(["en", "es", "fr-CA"])
  })

  it("omits archived extra lanes and empty tags", () => {
    expect(projectTargetLaneLanguages({
      targetLanguage: "en",
      targetLanes: ["es", "fr"],
      archivedLanes: ["es"],
    })).toEqual(["en", "fr"])
  })

  it("dedupes case-insensitively", () => {
    expect(projectTargetLaneLanguages({
      targetLanguage: "en",
      targetLanes: ["EN", "es"],
    })).toEqual(["en", "es"])
  })
})

describe("showVoiceLanguageBadge", () => {
  it("is true only when the project has more than one language lane", () => {
    expect(showVoiceLanguageBadge(["en"])).toBe(false)
    expect(showVoiceLanguageBadge(["en", "es"])).toBe(true)
    expect(showVoiceLanguageBadge([])).toBe(false)
  })
})
