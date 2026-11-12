import { describe, expect, it } from "vitest"
import {
  transcriptionLanguageCode, type TranscriptionLanguageLane,
} from "./transcription-language"

function lane(overrides: Partial<TranscriptionLanguageLane> = {}): TranscriptionLanguageLane {
  return {
    id: "aaaa0001",
    role: "target",
    language: null,
    name: null,
    langCode: null,
    legacyTag: "",
    position: 0,
    archivedAt: null,
    ...overrides,
  }
}

describe("transcriptionLanguageCode (AQU-2052)", () => {
  it("derives the code from a lane tagged with a language NAME", () => {
    expect(transcriptionLanguageCode([lane({ language: "Spanish" })])).toBe("es")
  })

  it("takes the lane's code override over the derived code", () => {
    expect(
      transcriptionLanguageCode([lane({ language: "Spanish", langCode: "es-MX" })]),
    ).toBe("es-MX")
  })

  it("answers null for a freeform label no catalog entry matches", () => {
    expect(transcriptionLanguageCode([lane({ language: "Grade 7 English" })])).toBeNull()
  })

  it("ignores the source lane and uses the first target lane in position order", () => {
    const lanes = [
      lane({ id: "ssss0000", role: "source", language: "English", legacyTag: null }),
      lane({ id: "bbbb0002", language: "French", legacyTag: "French", position: 2 }),
      lane({ id: "aaaa0001", language: "Spanish", position: 1 }),
    ]
    expect(transcriptionLanguageCode(lanes)).toBe("es")
  })

  it("skips an archived lane when falling back to first position", () => {
    const lanes = [
      lane({ id: "aaaa0001", language: "Spanish", position: 1, archivedAt: "2026-01-01T00:00:00Z" }),
      lane({ id: "bbbb0002", language: "French", legacyTag: "French", position: 2 }),
    ]
    expect(transcriptionLanguageCode(lanes)).toBe("fr")
  })

  it("uses the reader's stored lane choice when they have one", () => {
    const lanes = [
      lane({ id: "aaaa0001", language: "Spanish", position: 1 }),
      lane({ id: "bbbb0002", language: "French", legacyTag: "French", position: 2 }),
    ]
    expect(
      transcriptionLanguageCode(lanes, { stored: { laneId: "bbbb0002", legacyTag: null } }),
    ).toBe("fr")
  })

  it("falls back to first position when the stored lane is gone", () => {
    const lanes = [lane({ id: "aaaa0001", language: "Spanish" })]
    expect(
      transcriptionLanguageCode(lanes, { stored: { laneId: "zzzz9999", legacyTag: null } }),
    ).toBe("es")
  })

  it("passes through a lane label that is already a tag the lane catalog lacks", () => {
    // Tok Pisin is in no lane catalog, but Whisper and Omnilingual know "tpi".
    expect(transcriptionLanguageCode([lane({ language: "tpi" })])).toBe("tpi")
    expect(transcriptionLanguageCode([lane({ language: "zh-Hant" })])).toBe("zh-Hant")
  })

  it("answers null when the project carries no target lane rows", () => {
    expect(transcriptionLanguageCode(undefined)).toBeNull()
    expect(transcriptionLanguageCode([])).toBeNull()
    expect(transcriptionLanguageCode([lane({ id: "ssss0000", role: "source", language: "English" })]))
      .toBeNull()
  })
})
