import { describe, expect, it } from "vitest"
import { resolveImportDirection, type ImportDirectionLane } from "./import-direction"

const sourceLane: ImportDirectionLane = {
  id: "source-1",
  role: "source",
  language: "en",
  name: null,
  langCode: null,
  legacyTag: null,
  position: 0,
}

const frenchLane: ImportDirectionLane = {
  id: "target-1",
  role: "target",
  language: "fr",
  name: null,
  langCode: null,
  legacyTag: "fr",
  position: 1,
}

describe("resolveImportDirection", () => {
  it("does not ask when lane languages are en and fr and the active tag is empty", () => {
    const direction = resolveImportDirection({
      lanes: [sourceLane, frenchLane],
      activeTag: "",
      sourceLanguage: "",
      targetLanguage: "",
    })
    expect(direction).toEqual({ source: "en", target: "fr", needsDirection: false })
  })

  it("still asks when the project has no target-lane language", () => {
    const direction = resolveImportDirection({
      lanes: [sourceLane],
      activeTag: "",
      sourceLanguage: "",
      targetLanguage: "",
    })
    expect(direction.needsDirection).toBe(true)
    expect(direction.source).toBe("en")
    expect(direction.target).toBe("")
  })

  it("uses the language props when the project has no lane rows", () => {
    expect(resolveImportDirection({
      sourceLanguage: "en",
      targetLanguage: "fr",
      activeTag: "",
    }).needsDirection).toBe(false)

    expect(resolveImportDirection({
      sourceLanguage: "",
      targetLanguage: "",
      activeTag: "",
    }).needsDirection).toBe(true)
  })

  it("asks when the source and target lanes name the same language", () => {
    const direction = resolveImportDirection({
      lanes: [sourceLane, { ...frenchLane, language: "en", legacyTag: "en" }],
      activeTag: "",
    })
    expect(direction.needsDirection).toBe(true)
  })
})
