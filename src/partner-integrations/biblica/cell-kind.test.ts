import { describe, expect, it } from "vitest"
import { isBiblicaScriptureCell } from "./cell-kind"

describe("isBiblicaScriptureCell", () => {
  it("recognizes a verse cell of a Biblica study-Bible volume", () => {
    expect(isBiblicaScriptureCell({
      biblica: { version: 1, contentType: "scripture", bookCode: "GEN" },
    })).toBe(true)
  })

  it("does not claim the study notes, the front/back matter, or another edition", () => {
    expect(isBiblicaScriptureCell({ biblica: { contentType: "notes" } })).toBe(false)
    expect(isBiblicaScriptureCell({ biblica: { contentType: "front-back-matter" } })).toBe(false)
    expect(isBiblicaScriptureCell({ biblica: { contentType: "lesson" } })).toBe(false)
  })

  it("reads anything unrecognised as not scripture rather than throwing", () => {
    expect(isBiblicaScriptureCell(undefined)).toBe(false)
    expect(isBiblicaScriptureCell(null)).toBe(false)
    expect(isBiblicaScriptureCell({})).toBe(false)
    expect(isBiblicaScriptureCell({ biblica: "scripture" })).toBe(false)
    expect(isBiblicaScriptureCell([{ biblica: { contentType: "scripture" } }])).toBe(false)
  })
})
