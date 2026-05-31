import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { parseEBibleCorpus, fetchTranslationsList, __setVrefsForTest, __setTranslationsCacheForTest } from "./ebible"

describe("parseEBibleCorpus", () => {
  beforeEach(() => {
    __setVrefsForTest([
      "GEN 1:1",
      "GEN 1:2",
      "GEN 1:3",
      "GEN 1:4",
      "EXO 1:1",
      "EXO 1:2",
      "EXO 1:3",
      "MAT 1:1",
      "MAT 1:2",
      "MAT 1:3",
    ])
  })

  afterEach(() => {
    __setVrefsForTest(null)
  })

  it("zips corpus lines with verse references and drops blanks", () => {
    const corpus = [
      "In the beginning...",
      "", // missing verse
      "And God said Let there be light.",
      "   ", // whitespace-only, should be skipped
      "These are the names of the sons of Israel.",
      "Reuben, Simeon, Levi, and Judah.",
      "<range>", // range continuation marker, skipped
      "The book of the genealogy of Jesus Christ.",
      "Abraham begat Isaac.",
      "Isaac begat Jacob.",
    ].join("\n")

    const out = parseEBibleCorpus(corpus)

    expect(out.map((c) => c.context)).toEqual([
      "GEN 1:1",
      "GEN 1:3",
      "EXO 1:1",
      "EXO 1:2",
      "MAT 1:1",
      "MAT 1:2",
      "MAT 1:3",
    ])
    expect(out[0].original).toBe("In the beginning...")
    expect(out.every((c) => c.type === "verse")).toBe(true)
    expect(out.every((c) => c.translated === "")).toBe(true)
  })

  it("groups cells by book id (first token of vref)", () => {
    const corpus = [
      "g1",
      "g2",
      "g3",
      "g4",
      "e1",
      "e2",
      "e3",
      "m1",
      "m2",
      "m3",
    ].join("\n")

    const out = parseEBibleCorpus(corpus)
    const groups = new Set(out.map((c) => c.group))
    expect(groups).toEqual(new Set(["GEN", "EXO", "MAT"]))
    expect(out.filter((c) => c.group === "GEN")).toHaveLength(4)
    expect(out.filter((c) => c.group === "EXO")).toHaveLength(3)
    expect(out.filter((c) => c.group === "MAT")).toHaveLength(3)
  })

  it("gives each cell a unique id", () => {
    const corpus = "a\nb\nc"
    const out = parseEBibleCorpus(corpus)
    const ids = new Set(out.map((c) => c.id))
    expect(ids.size).toBe(out.length)
  })

  it("stops at the shorter of corpus / vref length", () => {
    const corpus = "a\nb"
    const out = parseEBibleCorpus(corpus)
    expect(out).toHaveLength(2)
    expect(out[1].context).toBe("GEN 1:2")
  })

  it("derives section from vref (BOOK CHAPTER)", () => {
    __setVrefsForTest(["GEN 1:1", "GEN 1:2", "GEN 2:1"])
    const out = parseEBibleCorpus("In the beginning.\nThe earth.\nThus the heavens.\n")
    expect(out[0].section).toBe("GEN 1")
    expect(out[1].section).toBe("GEN 1")
    expect(out[2].section).toBe("GEN 2")
  })

  it("tags each cell with globalReferences = [vref]", () => {
    __setVrefsForTest(["GEN 1:1", "GEN 1:2"])
    const out = parseEBibleCorpus("line 1\nline 2\n")
    expect(out[0].globalReferences).toEqual(["GEN 1:1"])
    expect(out[1].globalReferences).toEqual(["GEN 1:2"])
  })
})

describe("fetchTranslationsList – downloadable filter", () => {
  // Minimal CSV header matching what translations.csv provides (only the columns
  // the parser actually reads are needed; the rest are omitted with placeholder commas).
  const CSV_HEADER =
    "languageCode,translationId,languageName,languageNameInEnglish,dialect,homeDomain,title,description,Redistributable,Copyright,UpdateDate,publicationURL,OTbooks,OTchapters,OTverses,NTbooks,NTchapters,NTverses,DCbooks,DCchapters,DCverses,FCBHID,Certified,inScript,swordName,rodCode,textDirection,downloadable,font,shortTitle,PODISBN,script,sourceDate"

  function makeRow(langCode: string, transId: string, downloadable: string, redistributable = "True"): string {
    // Produces a row matching CSV_HEADER column order (33 columns total).
    // [0]=languageCode [1]=translationId [2]=languageName [3]=languageNameInEnglish
    // [4]=dialect [5]=homeDomain [6]=title [7]=description [8]=Redistributable
    // [9]=Copyright [10]=UpdateDate [11]=publicationURL [12]=OTbooks [13]=OTchapters
    // [14]=OTverses [15]=NTbooks [16]=NTchapters [17]=NTverses [18]=DCbooks
    // [19]=DCchapters [20]=DCverses [21]=FCBHID [22]=Certified [23]=inScript
    // [24]=swordName [25]=rodCode [26]=textDirection [27]=downloadable [28]=font
    // [29]=shortTitle [30]=PODISBN [31]=script [32]=sourceDate
    const cols = [
      langCode,       // 0 languageCode
      transId,        // 1 translationId
      "LangName",     // 2 languageName
      "LangNameEn",   // 3 languageNameInEnglish
      "",             // 4 dialect
      "domain.org",   // 5 homeDomain
      "Title",        // 6 title
      "Desc",         // 7 description
      redistributable,// 8 Redistributable
      "public domain",// 9 Copyright
      "2024-01-01",   // 10 UpdateDate
      "",             // 11 publicationURL
      "39",           // 12 OTbooks
      "0",            // 13 OTchapters
      "0",            // 14 OTverses
      "27",           // 15 NTbooks
      "0",            // 16 NTchapters
      "0",            // 17 NTverses
      "0",            // 18 DCbooks
      "0",            // 19 DCchapters
      "0",            // 20 DCverses
      "",             // 21 FCBHID
      "",             // 22 Certified
      "",             // 23 inScript
      "",             // 24 swordName
      "",             // 25 rodCode
      "ltr",          // 26 textDirection
      downloadable,   // 27 downloadable
      "",             // 28 font
      "ShortTitle",   // 29 shortTitle
      "",             // 30 PODISBN
      "Latin",        // 31 script
      "2024-01-01",   // 32 sourceDate
    ]
    return cols.join(",")
  }

  beforeEach(() => {
    // Clear the module-level cache before each test so fetch is actually called.
    __setTranslationsCacheForTest(null)
  })

  afterEach(() => {
    __setTranslationsCacheForTest(null)
    vi.restoreAllMocks()
  })

  it("returns only translations where downloadable=True", async () => {
    const csv = [
      CSV_HEADER,
      makeRow("aai", "aai", "True"),          // downloadable → include
      makeRow("eng", "engamp", "False"),        // not downloadable → exclude
      makeRow("fin", "fin", "False"),           // not downloadable → exclude
      makeRow("eng", "engBBE", "True"),         // downloadable → include
    ].join("\n")

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      text: async () => csv,
    }))

    const result = await fetchTranslationsList()
    expect(result.map((t) => t.id)).toEqual(["aai-aai", "eng-engBBE"])
  })

  it("excludes a row with downloadable=False even when redistributable=True", async () => {
    const csv = [
      CSV_HEADER,
      makeRow("eng", "engemtv", "False", "True"),
    ].join("\n")

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      text: async () => csv,
    }))

    const result = await fetchTranslationsList()
    expect(result).toHaveLength(0)
  })

  it("includes all rows when every entry has downloadable=True", async () => {
    const csv = [
      CSV_HEADER,
      makeRow("aai", "aai", "True"),
      makeRow("aak", "aak", "True"),
      makeRow("eng", "engBBE", "True"),
    ].join("\n")

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      text: async () => csv,
    }))

    const result = await fetchTranslationsList()
    expect(result).toHaveLength(3)
    expect(result.every((t) => t.downloadable)).toBe(true)
  })

  it("returns empty list when all entries are non-downloadable", async () => {
    const csv = [
      CSV_HEADER,
      makeRow("eng", "engamp", "False"),
      makeRow("fin", "fin", "False"),
    ].join("\n")

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      text: async () => csv,
    }))

    const result = await fetchTranslationsList()
    expect(result).toHaveLength(0)
  })

  it("parses the downloadable field onto the returned translation objects", async () => {
    const csv = [
      CSV_HEADER,
      makeRow("aai", "aai", "True"),
    ].join("\n")

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      text: async () => csv,
    }))

    const result = await fetchTranslationsList()
    expect(result[0].downloadable).toBe(true)
  })
})
