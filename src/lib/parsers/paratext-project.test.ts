import { describe, it, expect } from "vitest"
import {
  detectParatextProject,
  assembleParatextProject,
  type ProjectEntry,
} from "./paratext-project"

function entry(name: string, content: string): ProjectEntry {
  return { name, text: async () => content }
}

const SETTINGS_AR = `<ScriptureText>
  <Name>arONAV12</Name>
  <FullName>Biblica Open New Arabic Version 2012</FullName>
  <Language>Standard Arabic</Language>
  <LanguageIsoCode>arb:::</LanguageIsoCode>
  <Versification>4</Versification>
</ScriptureText>`

const BOOKNAMES_AR = `<BookNames>
  <book code="GEN" abbr="تك" short="التكوين" long="كِتَابُ التَّكْوِينِ" />
  <book code="MAT" abbr="مت" short="إنجيل متى" long="بِشَارَةُ مَتَّى" />
</BookNames>`

const MAT = `\\id MAT arONAV12\n\\h متى\n\\c 1\n\\v 1 في البَدْءِ.`
const GEN = `\\id GEN arONAV12\n\\h تكوين\n\\c 1\n\\v 1 في البَدْءِ خَلَقَ اللهُ.`

describe("detectParatextProject", () => {
  it("detects a project with Settings.xml + SFM files", () => {
    const d = detectParatextProject([
      entry("Settings.xml", SETTINGS_AR),
      entry("BookNames.xml", BOOKNAMES_AR),
      entry("41MATarONAV12.SFM", MAT),
    ])
    expect(d).not.toBeNull()
    expect(d!.sfmEntries).toHaveLength(1)
    expect(d!.bookNamesEntry).toBeTruthy()
  })

  it("returns null with neither Settings.xml nor BookNames.xml (just bare SFM)", () => {
    expect(detectParatextProject([entry("41MAT.SFM", MAT)])).toBeNull()
  })

  it("detects a BookNames-only bundle (no Settings.xml)", () => {
    const d = detectParatextProject([
      entry("BookNames.xml", BOOKNAMES_AR),
      entry("41MATarONAV12.SFM", MAT),
    ])
    expect(d).not.toBeNull()
    expect(d!.settingsEntry).toBeUndefined()
    expect(d!.bookNamesEntry).toBeTruthy()
    expect(d!.sfmEntries).toHaveLength(1)
  })

  it("returns null without any SFM files", () => {
    expect(detectParatextProject([entry("Settings.xml", SETTINGS_AR)])).toBeNull()
  })

  it("accepts a legacy .ssf settings file", () => {
    const d = detectParatextProject([entry("arONAV12.ssf", SETTINGS_AR), entry("41MAT.SFM", MAT)])
    expect(d).not.toBeNull()
  })

  it("handles nested paths (zip entries with directories)", () => {
    const d = detectParatextProject([
      entry("arONAV12/Settings.xml", SETTINGS_AR),
      entry("arONAV12/41MATarONAV12.SFM", MAT),
    ])
    expect(d).not.toBeNull()
  })
})

describe("assembleParatextProject", () => {
  it("orders books canonically (GEN before MAT) regardless of input order", async () => {
    const proj = (await assembleParatextProject([
      entry("Settings.xml", SETTINGS_AR),
      entry("BookNames.xml", BOOKNAMES_AR),
      entry("41MATarONAV12.SFM", MAT),
      entry("01GENarONAV12.SFM", GEN),
    ]))!
    expect(proj.books.map((b) => b.bookId)).toEqual(["GEN", "MAT"])
  })

  it("names books from BookNames (localized)", async () => {
    const proj = (await assembleParatextProject([
      entry("Settings.xml", SETTINGS_AR),
      entry("BookNames.xml", BOOKNAMES_AR),
      entry("01GENarONAV12.SFM", GEN),
      entry("41MATarONAV12.SFM", MAT),
    ]))!
    const byId = new Map(proj.books.map((b) => [b.bookId, b]))
    expect(byId.get("GEN")!.displayName).toBe("التكوين")
    expect(byId.get("MAT")!.displayName).toBe("إنجيل متى")
  })

  it("marks OT vs NT corpus", async () => {
    const proj = (await assembleParatextProject([
      entry("Settings.xml", SETTINGS_AR),
      entry("BookNames.xml", BOOKNAMES_AR),
      entry("01GENarONAV12.SFM", GEN),
      entry("41MATarONAV12.SFM", MAT),
    ]))!
    const byId = new Map(proj.books.map((b) => [b.bookId, b]))
    expect(byId.get("GEN")!.corpusMarker).toBe("OT")
    expect(byId.get("MAT")!.corpusMarker).toBe("NT")
  })

  it("captures language + RTL from settings", async () => {
    const proj = (await assembleParatextProject([
      entry("Settings.xml", SETTINGS_AR),
      entry("41MATarONAV12.SFM", MAT),
    ]))!
    expect(proj.settings.language).toBe("Standard Arabic")
    expect(proj.settings.languageIsoCode).toBe("arb")
    expect(proj.settings.rightToLeft).toBe(true)
  })

  it("falls back to English book name when BookNames is absent", async () => {
    const proj = (await assembleParatextProject([
      entry("Settings.xml", SETTINGS_AR),
      entry("01GEN.SFM", GEN),
    ]))!
    expect(proj.books[0].displayName).toBe("Genesis")
  })

  it("keeps the original filename + verse count + raw bytes per book", async () => {
    const proj = (await assembleParatextProject([
      entry("Settings.xml", SETTINGS_AR),
      entry("01GENarONAV12.SFM", GEN),
    ]))!
    expect(proj.books[0].fileName).toBe("01GENarONAV12.SFM")
    expect(proj.books[0].verseCount).toBe(1)
    expect(proj.books[0].rawSource).toBe(GEN)
  })

  it("infers RTL from content when settings omit the ISO code", async () => {
    const settingsNoIso = `<ScriptureText><Name>x</Name><Language>Arabic</Language></ScriptureText>`
    const proj = (await assembleParatextProject([
      entry("Settings.xml", settingsNoIso),
      entry("01GEN.SFM", GEN),
    ]))!
    expect(proj.settings.rightToLeft).toBe(true) // from Arabic content
  })

  it("assembles a BookNames-only bundle (no Settings): localized names + content-inferred RTL", async () => {
    const proj = (await assembleParatextProject([
      entry("BookNames.xml", BOOKNAMES_AR),
      entry("41MATarONAV12.SFM", MAT),
    ]))!
    expect(proj.books).toHaveLength(1)
    expect(proj.books[0].displayName).toBe("إنجيل متى") // from BookNames short
    expect(proj.settings.rightToLeft).toBe(true) // inferred from Arabic content
    expect(proj.settings.languageIsoCode).toBe("") // unknown without Settings
  })
})
