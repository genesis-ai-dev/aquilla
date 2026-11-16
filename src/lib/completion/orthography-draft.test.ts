import { describe, expect, it } from "vitest"
import { convertDraftOrthography, withOrthographyProvenance } from "./orthography-draft"
import { CANONICAL_APOSTROPHE, type OrthographyProfile } from "../../../db/shared/orthography"
import type { AiDraftProvenance } from "@/lib/sync/outbox-types"

const uzbek: OrthographyProfile = {
  rules: [["sh", "ş"], ["ch", "ç"], ["oʻ", "ö"]],
  apostrophe: CANONICAL_APOSTROPHE,
  exceptions: [{ word: "Isʼhoq", status: "approved" }],
}

const provenance = {
  model: "m",
  provider: "p",
  promptVersion: "1",
  exampleIds: [],
  generatedAt: 0,
  mode: "single",
  projectState: { sourceLanguage: "en", targetLanguage: "uz", approvedExampleCount: 0 },
} satisfies AiDraftProvenance

describe("convertDraftOrthography", () => {
  it("leaves a project with no orthography exactly as it was", () => {
    const draft = { value: "bo‘sh shahar", valueHtml: "<p>bo‘sh shahar</p>" }
    expect(convertDraftOrthography(draft, null)).toEqual({ draft })
    expect(convertDraftOrthography(draft, undefined).draft).toBe(draft)
  })

  it("converts the plain value and the HTML snapshot, leaving the tags alone", () => {
    const result = convertDraftOrthography(
      { value: "bo‘sh shahar", valueHtml: '<p class="shade">bo‘sh shahar</p>' },
      uzbek,
    )
    expect(result.draft.value).toBe("böş şahar")
    expect(result.draft.valueHtml).toBe('<p class="shade">böş şahar</p>')
  })

  it("reports what it did, counting both halves", () => {
    const result = convertDraftOrthography({ value: "shahar", valueHtml: "<p>shahar</p>" }, uzbek)
    expect(result.stats).toEqual({ wordsConverted: 2, exceptionsApplied: 0 })
  })

  it("keeps a cell with no HTML snapshot without one", () => {
    const result = convertDraftOrthography({ value: "shahar" }, uzbek)
    expect(result.draft).toEqual({ value: "şahar" })
    expect("valueHtml" in result.draft).toBe(false)
  })

  it("reports nothing when the draft was already in the lane's orthography", () => {
    expect(convertDraftOrthography({ value: "şahar" }, uzbek).stats).toBeUndefined()
  })

  it("counts an approved exception that protected a word", () => {
    const result = convertDraftOrthography({ value: "Ishoqning" }, uzbek)
    expect(result.draft.value).toBe("Isʼhoqning")
    expect(result.stats).toEqual({ wordsConverted: 0, exceptionsApplied: 1 })
  })
})

describe("withOrthographyProvenance", () => {
  it("records the conversion so Edit History can say one happened", () => {
    const stats = { wordsConverted: 3, exceptionsApplied: 1 }
    expect(withOrthographyProvenance(provenance, stats).orthography).toEqual(stats)
  })

  it("leaves the provenance alone when nothing was converted", () => {
    expect(withOrthographyProvenance(provenance, undefined)).toBe(provenance)
  })
})
