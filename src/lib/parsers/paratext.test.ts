import { describe, it, expect } from "vitest"
import {
  parseParatextSettings,
  parseBookNames,
  bookDisplayName,
  looksRightToLeft,
} from "./paratext"

// Trimmed but faithful to the real NAV (Arabic) 2012 Settings.xml.
const NAV_SETTINGS = `﻿<ScriptureText>
  <StyleSheet>usfm.sty</StyleSheet>
  <BooksPresent>1111110000</BooksPresent>
  <LanguageIsoCode>arb:::</LanguageIsoCode>
  <Language>Standard Arabic</Language>
  <FullName>Biblica® Open New Arabic Version 2012</FullName>
  <Encoding>65001</Encoding>
  <Name>arONAV12</Name>
  <Guid>b17e246951402e505b6b6eed2f01d5bd60b7bee5</Guid>
  <FileNameBookNameForm>41MAT</FileNameBookNameForm>
  <FileNamePrePart />
  <FileNamePostPart>arONAV12.SFM</FileNamePostPart>
  <Versification>4</Versification>
  <Copyright>&lt;p&gt;Copyright © 2012 by Biblica&lt;/p&gt;</Copyright>
</ScriptureText>`

const NAV_BOOKNAMES = `﻿<?xml version="1.0" encoding="utf-8"?>
<BookNames>
  <book code="GEN" abbr="تك" short="التكوين" long="كِتَابُ التَّكْوِينِ" />
  <book code="MAT" abbr="مت" short="متى" long="بِشَارَةُ مَتَّى" />
  <book code="PSA" abbr="مز" short="مزمور" long="كِتَابُ الْمَزَامِيرِ" />
</BookNames>`

describe("parseParatextSettings", () => {
  it("extracts the headline metadata", () => {
    const s = parseParatextSettings(NAV_SETTINGS)
    expect(s.name).toBe("arONAV12")
    expect(s.fullName).toBe("Biblica® Open New Arabic Version 2012")
    expect(s.language).toBe("Standard Arabic")
    expect(s.languageIsoCode).toBe("arb")
    expect(s.versification).toBe("4")
    expect(s.encoding).toBe("65001")
    expect(s.guid).toBe("b17e246951402e505b6b6eed2f01d5bd60b7bee5")
    expect(s.stylesheet).toBe("usfm.sty")
  })

  it("parses the file naming scheme", () => {
    const s = parseParatextSettings(NAV_SETTINGS)
    expect(s.naming.bookNameForm).toBe("41MAT")
    expect(s.naming.prePart).toBe("")
    expect(s.naming.postPart).toBe("arONAV12.SFM")
  })

  it("infers right-to-left from the Arabic ISO code", () => {
    expect(parseParatextSettings(NAV_SETTINGS).rightToLeft).toBe(true)
  })

  it("defaults rightToLeft false for an LTR language", () => {
    const s = parseParatextSettings(
      `<ScriptureText><Name>eng</Name><LanguageIsoCode>eng:::</LanguageIsoCode><Language>English</Language></ScriptureText>`,
    )
    expect(s.rightToLeft).toBe(false)
    expect(s.languageIsoCode).toBe("eng")
  })

  it("falls back FullName→Name when FullName absent", () => {
    const s = parseParatextSettings(`<ScriptureText><Name>xyz</Name></ScriptureText>`)
    expect(s.fullName).toBe("xyz")
  })
})

describe("parseBookNames", () => {
  it("parses localized book names keyed by code", () => {
    const names = parseBookNames(NAV_BOOKNAMES)
    expect(names.size).toBe(3)
    expect(names.get("GEN")?.short).toBe("التكوين")
    expect(names.get("MAT")?.long).toBe("بِشَارَةُ مَتَّى")
    expect(names.get("PSA")?.abbr).toBe("مز")
  })
})

describe("bookDisplayName", () => {
  const names = parseBookNames(NAV_BOOKNAMES)
  it("prefers localized short name", () => {
    expect(bookDisplayName("GEN", names)).toBe("التكوين")
  })
  it("falls back to English when the code isn't in BookNames", () => {
    expect(bookDisplayName("EXO", names, "Exodus")).toBe("Exodus")
  })
  it("falls back to the raw code when nothing else is known", () => {
    expect(bookDisplayName("ZZZ", names)).toBe("ZZZ")
  })
})

describe("looksRightToLeft", () => {
  it("detects Arabic content", () => {
    expect(looksRightToLeft("في الْبَدْءِ خَلَقَ اللهُ السَّمَاوَاتِ وَالأَرْضَ")).toBe(true)
  })
  it("detects Hebrew content", () => {
    expect(looksRightToLeft("בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם")).toBe(true)
  })
  it("returns false for English", () => {
    expect(looksRightToLeft("In the beginning God created the heavens")).toBe(false)
  })
})
