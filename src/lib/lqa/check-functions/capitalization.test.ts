import { describe, it, expect } from "vitest"
import { runCheck } from "./capitalization"

describe("capitalization check", () => {
  it("flags a lowercase sentence start in the translation", () => {
    const spans = runCheck("He went. Then he left.", "He went. then he left.")
    expect(spans).toHaveLength(1)
    expect(spans![0].side).toBe("target")
    expect(spans![0].matchedText).toBe("then")
  })

  it("passes a correctly capitalized translation", () => {
    expect(runCheck("He went. Then he left.", "He went. Then he left.")).toBeNull()
  })

  it("flags a lowercase word after a paragraph or heading marker", () => {
    expect(runCheck("\\s1 The call of Simon", "\\s1 the call of Simon")).not.toBeNull()
  })

  it("stays quiet when the source does the same thing at least as often", () => {
    // A software-localization or poetry source that runs lowercase after a
    // full stop is a style, not a translator's slip.
    expect(runCheck("save file. then exit.", "guardar archivo. luego salir.")).toBeNull()
  })

  it("still flags a target that offends MORE often than the source", () => {
    const spans = runCheck("Save file. then exit.", "guardar archivo. luego salir. y cerrar.")
    expect(spans).not.toBeNull()
    expect(spans!.length).toBeGreaterThan(1)
  })

  it("returns nothing for a caseless script", () => {
    expect(runCheck("He went. Then he left.", "وَذَهَبَ. ثُمَّ تَرَكَ.")).toBeNull()
  })
})
