import { describe, it, expect } from "vitest"
import { parseParatextSettings, bookFileName, bookCodeFromProjectFile, booksPresent, bookNumberToken, isUtf8Project } from "./project"
import { encodeRegistrationToken, decodeRegistrationToken, parseTranslationInfo } from "./registration"
import { BOOK_CODES_BY_NUMBER } from "./book-codes"

const SETTINGS = `﻿<ScriptureText>
  <StyleSheet>usfm.sty</StyleSheet>
  <Versification>4</Versification>
  <FullName>Test Paratext Project 1</FullName>
  <Encoding>65001</Encoding>
  <NormalizationForm>NFC</NormalizationForm>
  <Name>TPP1</Name>
  <Guid>6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d</Guid>
  <FileNamePrePart />
  <FileNamePostPart>TPP1.SFM</FileNamePostPart>
  <FileNameBookNameForm>41MAT</FileNameBookNameForm>
  <LanguageIsoCode>en:::</LanguageIsoCode>
  <TranslationInfo>Standard::</TranslationInfo>
  <BooksPresent>111111111111111111111111111111111111111111111111111111111111111111111111111111111111000000001111111111000011111100000000001</BooksPresent>
  <Naming PrePart="" PostPart="TPP1.SFM" BookNameForm="41MAT" />
</ScriptureText>`

/** Every book file a real Paratext 9.5 project (TPP1) wrote to disk. */
const REAL_FILES = `01GENTPP1.SFM 02EXOTPP1.SFM 03LEVTPP1.SFM 04NUMTPP1.SFM 05DEUTPP1.SFM 06JOSTPP1.SFM 07JDGTPP1.SFM 08RUTTPP1.SFM 091SATPP1.SFM 100XXGTPP1.SFM 102SATPP1.SFM 111KITPP1.SFM 122KITPP1.SFM 131CHTPP1.SFM 142CHTPP1.SFM 15EZRTPP1.SFM 16NEHTPP1.SFM 17ESTTPP1.SFM 18JOBTPP1.SFM 19PSATPP1.SFM 20PROTPP1.SFM 21ECCTPP1.SFM 22SNGTPP1.SFM 23ISATPP1.SFM 24JERTPP1.SFM 25LAMTPP1.SFM 26EZKTPP1.SFM 27DANTPP1.SFM 28HOSTPP1.SFM 29JOLTPP1.SFM 30AMOTPP1.SFM 31OBATPP1.SFM 32JONTPP1.SFM 33MICTPP1.SFM 34NAMTPP1.SFM 35HABTPP1.SFM 36ZEPTPP1.SFM 37HAGTPP1.SFM 38ZECTPP1.SFM 39MALTPP1.SFM 41MATTPP1.SFM 42MRKTPP1.SFM 43LUKTPP1.SFM 44JHNTPP1.SFM 45ACTTPP1.SFM 46ROMTPP1.SFM 471COTPP1.SFM 482COTPP1.SFM 49GALTPP1.SFM 50EPHTPP1.SFM 51PHPTPP1.SFM 52COLTPP1.SFM 531THTPP1.SFM 542THTPP1.SFM 551TITPP1.SFM 562TITPP1.SFM 57TITTPP1.SFM 58PHMTPP1.SFM 59HEBTPP1.SFM 60JASTPP1.SFM 611PETPP1.SFM 622PETPP1.SFM 631JNTPP1.SFM 642JNTPP1.SFM 653JNTPP1.SFM 66JUDTPP1.SFM 67REVTPP1.SFM 68TOBTPP1.SFM 69JDTTPP1.SFM 70ESGTPP1.SFM 71WISTPP1.SFM 72SIRTPP1.SFM 73BARTPP1.SFM 74LJETPP1.SFM 75S3YTPP1.SFM 76SUSTPP1.SFM 77BELTPP1.SFM 781MATPP1.SFM 792MATPP1.SFM 803MATPP1.SFM 814MATPP1.SFM 821ESTPP1.SFM 832ESTPP1.SFM 84MANTPP1.SFM 85PS2TPP1.SFM 94XXATPP1.SFM 95XXBTPP1.SFM 96XXCTPP1.SFM 97XXDTPP1.SFM 98XXETPP1.SFM 99XXFTPP1.SFM A0FRTTPP1.SFM A1BAKTPP1.SFM A2OTHTPP1.SFM A7INTTPP1.SFM A8CNCTPP1.SFM A9GLOTPP1.SFM B0TDXTPP1.SFM B1NDXTPP1.SFM B2DAGTPP1.SFM C3LAOTPP1.SFM`.split(" ")

describe("Paratext project naming", () => {
  const s = parseParatextSettings(SETTINGS)

  it("reads the settings the bridge needs", () => {
    expect(s.guid).toBe("6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d")
    expect(isUtf8Project(s)).toBe(true)
    expect(s.naming).toEqual({ prePart: "", postPart: "TPP1.SFM", bookNameForm: "41MAT" })
  })

  it("book numbers match Paratext's file names, including the gap at 40 and the letter series", () => {
    expect(bookNumberToken("GEN")).toBe("01")
    expect(bookNumberToken("MAL")).toBe("39")
    expect(bookNumberToken("MAT")).toBe("41")
    expect(bookNumberToken("REV")).toBe("67")
    expect(bookNumberToken("XXG")).toBe("100")
    expect(bookNumberToken("FRT")).toBe("A0")
    expect(bookNumberToken("INT")).toBe("A7")
    expect(bookNumberToken("TDX")).toBe("B0")
    expect(bookNumberToken("LAO")).toBe("C3")
    expect(BOOK_CODES_BY_NUMBER).toHaveLength(123)
  })

  it("BooksPresent bits name exactly the books the real project has on disk", () => {
    const present = booksPresent(s)
    const onDisk = REAL_FILES.map((f) => bookCodeFromProjectFile(s, f))
    expect(onDisk.every(Boolean)).toBe(true)
    expect(present.sort()).toEqual((onDisk as string[]).sort())
  })

  it("rebuilds every real file name from its code and back", () => {
    for (const f of REAL_FILES) {
      const code = bookCodeFromProjectFile(s, f)!
      expect(bookFileName(s, code)).toBe(f)
    }
    expect(bookCodeFromProjectFile(s, "Settings.xml")).toBeUndefined()
    expect(bookCodeFromProjectFile(s, "41MATOTHER.SFM")).toBeUndefined()
  })

  it("supports the other BookNameForm shapes", () => {
    const mat = parseParatextSettings(SETTINGS.replace(/41MAT/g, "MAT").replace("TPP1.SFM", ".usfm"))
    expect(bookFileName(mat, "MAT")).toBe("MAT.usfm")
    expect(bookCodeFromProjectFile(mat, "MAT.usfm")).toBe("MAT")
    const num = parseParatextSettings(SETTINGS.replace(/41MAT/g, "41"))
    expect(bookFileName(num, "MAT")).toBe("41TPP1.SFM")
    expect(bookCodeFromProjectFile(num, "41TPP1.SFM")).toBe("MAT")
  })
})

describe("registration token", () => {
  const fields = { sn: "TPP1", fn: "Test Paratext Project 1", id: "6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d", l: "en", un: "Ryder Wishart", t: "Standard", p: "" }

  it("encodes the documented sample and decodes it back", () => {
    const token = encodeRegistrationToken(fields)
    expect(token).not.toMatch(/=/)
    expect(decodeRegistrationToken(token)).toEqual(fields)
    // The decoded query matches the sample captured from a real Register link.
    const bin = atob(token + "=".repeat((4 - (token.length % 4)) % 4))
    expect(bin).toBe("sn=TPP1&fn=Test%20Paratext%20Project%201&id=6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d&l=en&un=Ryder%20Wishart&t=Standard&p=")
  })

  it("decodes URL-safe alphabet tokens too", () => {
    const std = encodeRegistrationToken({ ...fields, fn: "ÿÿ??>>" })
    const urlSafe = std.replace(/\+/g, "-").replace(/\//g, "_")
    expect(decodeRegistrationToken(urlSafe)).toEqual(decodeRegistrationToken(std))
  })

  it("splits TranslationInfo into type and parent", () => {
    expect(parseTranslationInfo("Standard::")).toEqual({ type: "Standard", parent: "" })
    expect(parseTranslationInfo("BackTranslation:TPP1:")).toEqual({ type: "BackTranslation", parent: "TPP1" })
  })
})
