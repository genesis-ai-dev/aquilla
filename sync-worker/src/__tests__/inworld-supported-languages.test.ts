import { describe, expect, it } from "vitest"
import { parseInworldSupportedLanguages } from "../inworld-supported-languages"

describe("parseInworldSupportedLanguages", () => {
  it("keeps Inworld portal rows and drops undetermined", () => {
    const rows = parseInworldSupportedLanguages({
      supportedLanguages: [
        {
          code: "kbt",
          familyCode: "kbt",
          familyDisplayName: "Abadi",
          accentDisplayName: "",
          displayName: "Abadi",
          creationEnabled: true,
          hasVoices: true,
        },
        {
          code: "und",
          familyCode: "und",
          familyDisplayName: "Undetermined",
          accentDisplayName: "",
          displayName: "Undetermined",
          creationEnabled: true,
          hasVoices: true,
        },
      ],
    })
    expect(rows).toEqual([
      {
        code: "kbt",
        familyCode: "kbt",
        familyDisplayName: "Abadi",
        accentDisplayName: "",
        displayName: "Abadi",
        creationEnabled: true,
        hasVoices: true,
      },
    ])
  })
})
