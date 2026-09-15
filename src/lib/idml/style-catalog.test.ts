import { describe, expect, it } from "vitest"
import {
  extractIdmlStyleCatalog,
  idmlParagraphStyleFromMetadata,
  idmlStyleCatalogFromMetadata,
  idmlStyleDisplayMetadata,
} from "./style-catalog"

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles xmlns:idPkg="urn:test">
  <RootCharacterStyleGroup>
    <CharacterStyle Self="CharacterStyle/Body"/>
    <CharacterStyle Self="CharacterStyle/Bold" FontStyle="Bold"/>
    <CharacterStyle Self="CharacterStyle/Italic" FontStyle="Italic"/>
    <CharacterStyle Self="CharacterStyle/Emphasis" BasedOn="CharacterStyle/Italic"/>
    <CharacterStyle Self="CharacterStyle/Underline" Underline="true"/>
    <CharacterStyle Self="CharacterStyle/StrongItalic" FontStyle="Bold Italic"/>
  </RootCharacterStyleGroup>
</idPkg:Styles>`

describe("extractIdmlStyleCatalog", () => {
  it("keeps only Bold and Italic faces, including BasedOn inheritance", () => {
    const catalog = extractIdmlStyleCatalog(STYLES)
    expect(catalog["CharacterStyle/Bold"]).toEqual({ bold: true, italic: false })
    expect(catalog["CharacterStyle/Italic"]).toEqual({ bold: false, italic: true })
    expect(catalog["CharacterStyle/Emphasis"]).toEqual({ bold: false, italic: true })
    expect(catalog["CharacterStyle/StrongItalic"]).toEqual({ bold: true, italic: true })
    expect(catalog["CharacterStyle/Body"]).toBeUndefined()
    expect(catalog["CharacterStyle/Underline"]).toBeUndefined()
  })

  it("inherits Bold through InDesign's child BasedOn, as Biblica k → bd", () => {
    const catalog = extractIdmlStyleCatalog(`<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles xmlns:idPkg="urn:test">
  <CharacterStyle Self="CharacterStyle/bd" FontStyle="Bold">
    <Properties><BasedOn type="string">$ID/[No character style]</BasedOn></Properties>
  </CharacterStyle>
  <CharacterStyle Self="CharacterStyle/k">
    <Properties><BasedOn type="object">CharacterStyle/bd</BasedOn></Properties>
  </CharacterStyle>
</idPkg:Styles>`)
    expect(catalog["CharacterStyle/k"]).toEqual({ bold: true, italic: false })
  })

  it("stores a heading paragraph style used by unstyled Treasure Hunt runs", () => {
    const catalog = extractIdmlStyleCatalog(`<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles xmlns:idPkg="urn:test">
  <ParagraphStyle Self="ParagraphStyle/!meta_hunt_head" FontStyle="Semibold SemiCondensed"/>
  <ParagraphStyle Self="ParagraphStyle/!meta_fact_head" FontStyle="Regular"/>
</idPkg:Styles>`)
    expect(idmlStyleDisplayMetadata(catalog, [
      "CharacterStyle/$ID/[No character style]",
      "ParagraphStyle/!meta_hunt_head",
    ])).toEqual({
      idmlStyleDisplay: {
        "ParagraphStyle/!meta_hunt_head": { bold: true, italic: false },
      },
    })
    expect(idmlStyleDisplayMetadata(catalog, ["ParagraphStyle/!meta_fact_head"])).toBeUndefined()
  })
})

describe("idml style display metadata", () => {
  it("stores only the styles a cell actually uses", () => {
    const catalog = extractIdmlStyleCatalog(STYLES)
    expect(idmlStyleDisplayMetadata(catalog, ["CharacterStyle/Body"])).toBeUndefined()
    expect(idmlStyleDisplayMetadata(catalog, ["CharacterStyle/Emphasis", "CharacterStyle/Body"]))
      .toEqual({
        idmlStyleDisplay: {
          "CharacterStyle/Emphasis": { bold: false, italic: true },
        },
      })
  })

  it("reads a persisted catalog back for already-imported cells", () => {
    expect(idmlStyleCatalogFromMetadata({
      idml: { version: 2 },
      idmlStyleDisplay: {
        "CharacterStyle/Emphasis": { bold: false, italic: true },
        skip: { bold: "yes" },
      },
    })).toEqual({
      "CharacterStyle/Emphasis": { bold: false, italic: true },
    })
    expect(idmlStyleCatalogFromMetadata({ idml: { version: 2 } })).toBeUndefined()
  })

  it("reads the paragraph style from new imports and already-imported Biblica cells", () => {
    expect(idmlParagraphStyleFromMetadata({
      idmlParagraphStyle: "ParagraphStyle/!meta_hunt_head",
      biblica: { paragraphStyle: "ParagraphStyle/!meta_par" },
    })).toBe("ParagraphStyle/!meta_hunt_head")
    expect(idmlParagraphStyleFromMetadata({
      biblica: { paragraphStyle: "ParagraphStyle/_intro_head" },
    })).toBe("ParagraphStyle/_intro_head")
    expect(idmlParagraphStyleFromMetadata({ idml: { version: 2 } })).toBeUndefined()
  })
})
