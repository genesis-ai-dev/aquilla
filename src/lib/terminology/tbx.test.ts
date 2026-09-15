import { describe, it, expect } from "vitest"
import { exportConceptsTbx, importConceptsTbx } from "./tbx"
import type { Concept } from "./types"

const concept: Concept = {
  id: "c1",
  sourceTerm: "הָאָ֗רֶץ",
  renderings: [{ rendering: "earth", status: "preferred" }],
  status: "active",
  createdAt: "2026-09-14T00:00:00.000Z",
  match: { foldMarks: true, affixes: false, forms: ["אֶרֶץ"], excludedForms: ["בארץ"] },
}

describe("TBX match options", () => {
  // WHY: a termbase exported and re-imported must not silently lose the
  // matching rules users tuned; forms are standard TBX variants, options are
  // an Aquilla-specific note.
  it("round-trips forms as variant tigs and options as a termNote", () => {
    const xml = exportConceptsTbx([concept])
    expect(xml).toContain('<termNote type="termType">variant</termNote>')
    expect(xml).toContain('<termNote type="aquillaMatchOptions">')
    const [back] = importConceptsTbx(xml)
    expect(back.sourceTerm).toBe("הָאָ֗רֶץ")
    expect(back.match).toEqual(concept.match)
  })

  // WHY: files from other tools have no such note; import must not choke.
  it("imports legacy files without options unchanged", () => {
    const [back] = importConceptsTbx(exportConceptsTbx([{ ...concept, match: undefined }]))
    expect(back.match).toBeUndefined()
  })
})
