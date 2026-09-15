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

describe("TBX import robustness", () => {
  // WHY: the options note is free-form XML text — a hand-written or foreign
  // TBX can put a bare string where the matcher expects an array. Before
  // validation that landed straight on Concept.match and blew up inside
  // resolveMatchOptions (.map of a string) the first time anything matched.
  // The concept must still import; only the bad options are dropped.
  it("ignores an options note whose field types are wrong", () => {
    const xml = `<martif type="TBX-Basic" xml:lang="en"><text><body>
      <termEntry id="c-bad">
        <langSet xml:lang="source">
          <tig>
            <term>הָאָ֗רֶץ</term>
            <termNote type="aquillaMatchOptions">{"forms":"אֶרֶץ","foldMarks":"yes"}</termNote>
          </tig>
        </langSet>
      </termEntry>
    </body></text></martif>`
    const [back] = importConceptsTbx(xml)
    expect(back.sourceTerm).toBe("הָאָ֗רֶץ")
    expect(back.match).toBeUndefined()
  })

  // WHY: the head tig is the source term by position, not by termType. A file
  // that marks every source tig as a variant (some exporters do) must still
  // import with the head as sourceTerm rather than throwing or losing it.
  it("keeps the head tig as sourceTerm even when it is marked variant", () => {
    const xml = `<martif type="TBX-Basic" xml:lang="en"><text><body>
      <termEntry id="c-var">
        <langSet xml:lang="source">
          <tig>
            <term>הָאָ֗רֶץ</term>
            <termNote type="termType">variant</termNote>
          </tig>
          <tig>
            <term>אֶרֶץ</term>
            <termNote type="termType">variant</termNote>
          </tig>
        </langSet>
      </termEntry>
    </body></text></martif>`
    const concepts = importConceptsTbx(xml)
    expect(concepts).toHaveLength(1)
    expect(concepts[0].sourceTerm).toBe("הָאָ֗רֶץ")
    expect(concepts[0].match?.forms).toEqual(["אֶרֶץ"])
  })
})
