import { describe, expect, it } from "vitest"
import { extractIdmlStyleCatalog, styleCatalogForSlots } from "./style-catalog.js"

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles xmlns:idPkg="urn:test">
  <CharacterStyle Self="CharacterStyle/Body"/>
  <CharacterStyle Self="CharacterStyle/Bold" FontStyle="Bold"/>
  <CharacterStyle Self="CharacterStyle/Italic" FontStyle="Italic"/>
  <CharacterStyle Self="CharacterStyle/Emphasis" BasedOn="CharacterStyle/Italic"/>
  <CharacterStyle Self="CharacterStyle/Underline" Underline="true"/>
</idPkg:Styles>`

describe("IDML style catalog", () => {
  it("extracts only Bold and Italic FontStyle faces", () => {
    const catalog = extractIdmlStyleCatalog(STYLES)
    expect(catalog).toEqual({
      "CharacterStyle/Bold": { bold: true, italic: false },
      "CharacterStyle/Italic": { bold: false, italic: true },
      "CharacterStyle/Emphasis": { bold: false, italic: true },
    })
    expect(styleCatalogForSlots(catalog, ["CharacterStyle/Body"])).toBeUndefined()
    expect(styleCatalogForSlots(catalog, ["CharacterStyle/Emphasis"])).toEqual({
      "CharacterStyle/Emphasis": { bold: false, italic: true },
    })
  })

  it("resolves BasedOn from a Properties child the way InDesign writes it", () => {
    const catalog = extractIdmlStyleCatalog(`<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles xmlns:idPkg="urn:test">
  <CharacterStyle Self="CharacterStyle/bd" FontStyle="Bold">
    <Properties><BasedOn type="string">$ID/[No character style]</BasedOn></Properties>
  </CharacterStyle>
  <CharacterStyle Self="CharacterStyle/k">
    <Properties><BasedOn type="object">CharacterStyle/bd</BasedOn></Properties>
  </CharacterStyle>
  <CharacterStyle Self="CharacterStyle/#base.it" FontStyle="Italic">
    <Properties><BasedOn type="string">$ID/[No character style]</BasedOn></Properties>
  </CharacterStyle>
  <CharacterStyle Self="CharacterStyle/em">
    <Properties><BasedOn type="object">CharacterStyle/#base.it</BasedOn></Properties>
  </CharacterStyle>
</idPkg:Styles>`)
    expect(catalog["CharacterStyle/k"]).toEqual({ bold: true, italic: false })
    expect(catalog["CharacterStyle/em"]).toEqual({ bold: false, italic: true })
  })

  it("extracts paragraph-style faces and lets an explicit Regular replace inherited Bold", () => {
    const catalog = extractIdmlStyleCatalog(`<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles xmlns:idPkg="urn:test">
  <ParagraphStyle Self="ParagraphStyle/!meta_head" FontStyle="Bold"/>
  <ParagraphStyle Self="ParagraphStyle/!meta_hunt_head" FontStyle="Semibold SemiCondensed">
    <Properties><BasedOn type="object">ParagraphStyle/!meta_head</BasedOn></Properties>
  </ParagraphStyle>
  <ParagraphStyle Self="ParagraphStyle/!meta_fact_head" FontStyle="Regular">
    <Properties><BasedOn type="object">ParagraphStyle/!meta_hunt_head</BasedOn></Properties>
  </ParagraphStyle>
  <ParagraphStyle Self="ParagraphStyle/_intro_head" FontStyle="Bold"/>
  <ParagraphStyle Self="ParagraphStyle/#TreasureFact" FontStyle="Narrow Bold"/>
  <ParagraphStyle Self="ParagraphStyle/#TreasureHunt">
    <Properties><BasedOn type="object">ParagraphStyle/#TreasureFact</BasedOn></Properties>
  </ParagraphStyle>
  <CharacterStyle Self="CharacterStyle/_meta_style%3abold" FontStyle="Bold"/>
</idPkg:Styles>`)
    expect(catalog["ParagraphStyle/!meta_hunt_head"]).toEqual({ bold: true, italic: false })
    expect(catalog["ParagraphStyle/_intro_head"]).toEqual({ bold: true, italic: false })
    expect(catalog["ParagraphStyle/#TreasureHunt"]).toEqual({ bold: true, italic: false })
    expect(catalog["CharacterStyle/_meta_style%3abold"]).toEqual({ bold: true, italic: false })
    expect(catalog["ParagraphStyle/!meta_fact_head"]).toBeUndefined()
    expect(styleCatalogForSlots(catalog, [
      "CharacterStyle/$ID/[No character style]",
      "ParagraphStyle/!meta_hunt_head",
    ])).toEqual({
      "ParagraphStyle/!meta_hunt_head": { bold: true, italic: false },
    })
  })
})
