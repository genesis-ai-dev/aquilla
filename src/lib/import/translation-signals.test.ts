/**
 * AQU-1365: the source path's "is this a translation?" check.
 *
 * WHY each case matters:
 *  - The pilot's Tatar Jonah (`\id JON Siberian Tatar`) must be caught on both
 *    signals, since it is exactly the upload that became a second Jonah.
 *  - A clear source text must never be flagged (AC3): the unfoldingWord ULT
 *    header names a language, but the SOURCE one.
 *  - Language matching is on whole words: a two-letter code is an ordinary
 *    word in free text ("it", "no"), and "Frankish" is not "fr".
 *  - Files the collision screen already answered for are not asked again.
 */

import { describe, it, expect } from "vitest"
import {
  EMPTY_UPLOAD_HEADER,
  mentionsLanguage,
  translationCheckLayout,
  translationSignals,
  uploadHeaderText,
  type TranslationCheckUpload,
} from "./translation-signals"
import type { LanguageEntry } from "@/lib/languages/catalog"

const FILES = [
  { id: "jonah", name: "Jonah", bookCode: "JON", type: "usfm" },
  { id: "ruth", name: "Ruth", bookCode: "RUT", type: "usfm" },
  { id: "episode", name: "Episode 1", type: "vtt" },
]

const CATALOG: LanguageEntry[] = [
  { code: "sty", name: "Siberian Tatar" },
  { code: "fra", name: "French", altCode: "fr" },
  { code: "eng", name: "English", altCode: "en" },
]

function upload(fileName: string, text: string, bookIds: string[] = []): TranslationCheckUpload {
  return {
    fileKey: fileName,
    fileName,
    bookIds,
    header: uploadHeaderText(fileName, text),
    importKeys: [fileName.toLowerCase(), ...bookIds],
  }
}

function signals(uploads: TranslationCheckUpload[], overrides: Partial<Parameters<typeof translationSignals>[0]> = {}) {
  return translationSignals({
    uploads,
    existingFiles: FILES,
    sourceLanguage: "English",
    targetLanguages: ["Siberian Tatar"],
    catalog: CATALOG,
    ...overrides,
  })
}

describe("uploadHeaderText", () => {
  it("reads the rest of the \\id line and \\rem lines, before the first chapter", () => {
    const text = "﻿\\id JON Siberian Tatar (test)\n\\rem Translated 2026\n\\h Jonah\n\\c 1\n\\rem not this\n\\v 1 text\n"
    expect(uploadHeaderText("JON.usfm", text)).toEqual({
      fields: [],
      notes: ["Siberian Tatar (test)", "Translated 2026"],
    })
  })

  it("takes only the code-shaped parts of the \\id line as fields", () => {
    expect(uploadHeaderText("JON.usfm", "\\id JON sty\n\\c 1\n")).toEqual({ fields: ["sty"], notes: ["sty"] })
    expect(uploadHeaderText("PSA.usfm", "\\id PSA EN_ULT en_English_ltr unfoldingWord Literal Text\n")).toEqual({
      fields: ["EN_ULT", "en_English_ltr"],
      notes: ["EN_ULT en_English_ltr unfoldingWord Literal Text"],
    })
  })

  it("keeps a WebVTT header's Language value and title, and stops at the first blank line", () => {
    const text = "WEBVTT - Episode 1 subtitles\nKind: captions\nLanguage: sty\n\n00:00.000 --> 00:01.000\nLanguage: en\n"
    expect(uploadHeaderText("episode.vtt", text)).toEqual({
      fields: ["sty"],
      notes: ["Episode 1 subtitles"],
    })
  })

  it("has nothing to say about other formats", () => {
    expect(uploadHeaderText("notes.docx", "\\id JON Siberian Tatar")).toEqual(EMPTY_UPLOAD_HEADER)
    expect(uploadHeaderText("cues.srt", "1\n00:00:00,000 --> 00:00:01,000\nhi")).toEqual(EMPTY_UPLOAD_HEADER)
  })
})

describe("mentionsLanguage", () => {
  it("matches a name as a whole phrase, ignoring case and punctuation", () => {
    expect(mentionsLanguage({ fields: ["SIBERIAN-TATAR (test)"], notes: [] }, "Siberian Tatar")).toBe(true)
    expect(mentionsLanguage({ fields: ["Siberian Tatarstan"], notes: [] }, "Siberian Tatar")).toBe(false)
  })

  it("knows a language's codes from the catalog", () => {
    expect(mentionsLanguage({ fields: ["sty"], notes: [] }, "Siberian Tatar", CATALOG)).toBe(true)
    expect(mentionsLanguage({ fields: ["fr_French_ltr"], notes: [] }, "French", CATALOG)).toBe(true)
  })

  it("only counts a two-letter code in a structured field, never inside a word", () => {
    expect(mentionsLanguage({ fields: ["fr"], notes: [] }, "French")).toBe(true)
    expect(mentionsLanguage({ fields: [], notes: ["fr"] }, "French")).toBe(false)
    expect(mentionsLanguage({ fields: ["Frankish"], notes: [] }, "French")).toBe(false)
  })

  // AQU-1365 review: many three-letter codes are English words. In free text
  // they must not turn a plain source upload into "This looks like a
  // translation".
  it("never counts a three-letter code in free text, where it is usually a word", () => {
    const catalog: LanguageEntry[] = [
      { code: "for", name: "Fore" },
      { code: "the", name: "Chitwania Tharu" },
      { code: "dan", name: "Danish", altCode: "da" },
      { code: "one", name: "Oneida" },
    ]
    const header = (text: string) => uploadHeaderText("MRK.usfm", `${text}\n\\c 1\n`)
    expect(mentionsLanguage(header("\\id MRK\n\\rem Prepared for community checking"), "Fore", catalog)).toBe(false)
    expect(mentionsLanguage(header("\\id MRK The Gospel of Mark"), "Chitwania Tharu", catalog)).toBe(false)
    expect(mentionsLanguage(header("\\id MRK\n\\rem cross references to Dan 7"), "Danish", catalog)).toBe(false)
    expect(mentionsLanguage(header("\\id MRK\n\\rem Draft one"), "Oneida", catalog)).toBe(false)
    // As a code where a code belongs, and by name anywhere, it still counts.
    expect(mentionsLanguage(header("\\id MRK for"), "Fore", catalog)).toBe(true)
    expect(mentionsLanguage(header("\\id MRK the_Tharu"), "Chitwania Tharu", catalog)).toBe(true)
    expect(mentionsLanguage(header("\\id MRK\n\\rem Danish translation"), "Danish", catalog)).toBe(true)
    expect(mentionsLanguage(uploadHeaderText("ep.vtt", "WEBVTT\nLanguage: dan\n\n"), "Danish", catalog)).toBe(true)
  })
})

describe("translationSignals", () => {
  it("flags the pilot's Tatar Jonah on both its book and its language", () => {
    const found = signals([upload("JON-tatar.usfm", "\\id JON Siberian Tatar (test)\n\\c 1\n", ["JON"])])
    expect(found).toEqual([{
      fileKey: "JON-tatar.usfm",
      fileName: "JON-tatar.usfm",
      bookIds: ["JON"],
      sameBook: [{ bookCode: "JON", files: [{ id: "jonah", name: "Jonah" }] }],
      language: "Siberian Tatar",
    }])
  })

  it("flags a book already here even when the file names no language", () => {
    const [found] = signals([upload("RUT-tatar.usfm", "\\id RUT\n\\c 1\n", ["RUT"])])
    expect(found.sameBook[0].files).toEqual([{ id: "ruth", name: "Ruth" }])
    expect(found.language).toBeUndefined()
  })

  it("flags a new book whose header names the target language", () => {
    const [found] = signals([upload("GEN1-tatar.usfm", "\\id GEN Siberian Tatar (test)\n\\c 1\n", ["GEN"])])
    expect(found.sameBook).toEqual([])
    expect(found.language).toBe("Siberian Tatar")
  })

  it("leaves a clear source text alone, however much its header says", () => {
    expect(signals([upload("PSA.usfm", "\\id PSA EN_ULT en_English_ltr unfoldingWord Literal Text\n\\c 1\n", ["PSA"])])).toEqual([])
    expect(signals([upload("MRK.usfm", "\\id MRK\n\\c 1\n", ["MRK"])])).toEqual([])
  })

  it("says nothing about language when the header names the source language too", () => {
    const found = signals([upload("GEN.usfm", "\\id GEN Siberian Tatar\n\\rem from the English\n\\c 1\n", ["GEN"])])
    expect(found).toEqual([])
  })

  it("recognises a code and a two-letter code in the right places", () => {
    expect(signals([upload("GEN.usfm", "\\id GEN sty\n\\c 1\n", ["GEN"])])[0]?.language).toBe("Siberian Tatar")
    expect(signals(
      [upload("GEN.usfm", "\\id GEN fr_French_ltr\n\\c 1\n", ["GEN"])],
      { targetLanguages: ["French"] },
    )[0]?.language).toBe("French")
    expect(signals(
      [upload("GEN.usfm", "\\id GEN Frankish\n\\c 1\n", ["GEN"])],
      { targetLanguages: ["French"] },
    )).toEqual([])
  })

  it("reads a subtitle file's Language header", () => {
    const [found] = signals([upload("episode-tatar.vtt", "WEBVTT\nLanguage: sty\n\n00:00.000 --> 00:01.000\nСәлам\n")])
    expect(found.language).toBe("Siberian Tatar")
    expect(found.sameBook).toEqual([])
  })

  it("does not ask again about a file the collision screen already resolved", () => {
    const jonah = upload("JON-tatar.usfm", "\\id JON Siberian Tatar\n\\c 1\n", ["JON"])
    expect(signals([jonah], { skipImportKeys: new Set(["JON"]) })).toEqual([])
    expect(signals([jonah], { skipImportKeys: new Set(["jon-tatar.usfm"]) })).toEqual([])
  })

  it("lists every file that holds the book when there are two", () => {
    const [found] = signals(
      [upload("JON.usfm", "\\id JON\n\\c 1\n", ["JON"])],
      { existingFiles: [...FILES, { id: "jonah-2", name: "Jonah (2)", bookCode: "JON", type: "usfm" }] },
    )
    expect(found.sameBook[0].files.map((file) => file.id)).toEqual(["jonah", "jonah-2"])
  })

  it("says nothing about language without a target language, or in an empty project", () => {
    expect(signals([upload("GEN.usfm", "\\id GEN Siberian Tatar\n\\c 1\n", ["GEN"])], { targetLanguages: [] })).toEqual([])
    expect(signals([upload("GEN.usfm", "\\id GEN Siberian Tatar\n\\c 1\n", ["GEN"])], { existingFiles: [] })).toEqual([])
  })

  it("ignores a target language that is the source language", () => {
    expect(signals(
      [upload("GEN.usfm", "\\id GEN English\n\\c 1\n", ["GEN"])],
      { targetLanguages: ["eng"] },
    )).toEqual([])
  })

  it("finds a migrated file's book by its name", () => {
    const [found] = signals(
      [upload("1CH.usfm", "\\id 1CH\n\\c 1\n", ["1CH"])],
      { existingFiles: [{ id: "chron", name: "1CH", type: "codex" }] },
    )
    expect(found.sameBook[0].files).toEqual([{ id: "chron", name: "1CH" }])
  })
})

describe("translationCheckLayout", () => {
  const jonah = signals([upload("JON-tatar.usfm", "\\id JON Siberian Tatar\n\\c 1\n", ["JON"])])[0]
  const genesis = signals([upload("GEN.usfm", "\\id GEN Siberian Tatar\n\\c 1\n", ["GEN"])])[0]

  it("asks about one file by what fired", () => {
    expect(translationCheckLayout([jonah], 1)).toMatchObject({
      kind: "sameBook", book: { bookCode: "JON", file: { id: "jonah", name: "Jonah" } },
    })
    expect(translationCheckLayout([genesis], 1).kind).toBe("language")
  })

  it("can't offer one destination when two files hold the book, or the file holds two books", () => {
    const twoJonahs = { ...jonah, sameBook: [{ bookCode: "JON", files: [{ id: "a", name: "Jonah" }, { id: "b", name: "Jonah" }] }] }
    expect(translationCheckLayout([twoJonahs], 1)).toMatchObject({ kind: "sameBookAmbiguous", bookName: "Jonah" })
    expect(translationCheckLayout([{ ...jonah, bookIds: ["JON", "RUT"] }], 1).kind).toBe("multiBook")
  })

  it("asks about a batch as a whole", () => {
    expect(translationCheckLayout([jonah], 2).kind).toBe("many")
    expect(translationCheckLayout([jonah, genesis], 2).kind).toBe("many")
  })
})
