// AQU-1365: where a dropped translation goes. WHY: the import follows the
// person (Sam's PR 3 ruling), so an upload's book never moves it; it only
// lets a held upload name its book and offer the one file that holds it. An
// ambiguous book (two \id lines, two files of one book, none) must offer
// nothing, and a spreadsheet's book is read from its reference column, never
// from a translation that happens to quote a verse.
import { describe, expect, it } from "vitest"
import { fileBookCode } from "@/lib/sidebar/group-by-corpus"
import {
  filesForBook,
  isUsfmFileName,
  sheetBookIds,
  suggestTranslationDestination,
  uploadBookIds,
  usfmBookIds,
  type TranslationDestination,
} from "./translation-destination"

const JONAH: TranslationDestination = { id: "jonah", name: "Jonah", bookCode: "JON", type: "usfm" }
const RUTH: TranslationDestination = { id: "ruth", name: "Ruth", bookCode: "RUT", type: "usfm" }
const EPISODE: TranslationDestination = { id: "ep1", name: "Episode 1", type: "vtt" }
const FILES = [JONAH, RUTH, EPISODE]

describe("usfmBookIds", () => {
  it("reads the book code, uppercased, past a byte-order mark and a description", () => {
    expect(usfmBookIds("﻿\\id jon - Siberian Tatar (test)\n\\c 1\n\\v 1 Text")).toEqual(["JON"])
  })

  it("reads every book in a file holding two", () => {
    const text = "\\id RUT\n\\c 1\n\\v 1 a\n\\c 4\n\\v 22 b\n\\id JON\n\\c 1\n\\v 1 c\n"
    expect(usfmBookIds(text)).toEqual(["RUT", "JON"])
  })

  it("counts a book once however often it is named", () => {
    expect(usfmBookIds("\\id JON\n\\c 1\n\\id JON\n")).toEqual(["JON"])
  })

  it("finds nothing without an \\id line, and ignores \\ide", () => {
    expect(usfmBookIds("\\ide UTF-8\n\\c 1\n\\v 1 a")).toEqual([])
  })
})

describe("isUsfmFileName", () => {
  it("knows the three USFM extensions in any case", () => {
    expect(["a.usfm", "b.SFM", "c.usf"].map(isUsfmFileName)).toEqual([true, true, true])
    expect(["a.csv", "b.vtt", "usfm"].map(isUsfmFileName)).toEqual([false, false, false])
  })
})

describe("filesForBook / fileBookCode", () => {
  it("matches a file by its book code", () => {
    expect(filesForBook(FILES, "rut")).toEqual([RUTH])
  })

  it("falls back to the name of a migrated Codex file that has no book code", () => {
    const chronicles = { id: "1ch", name: "1CH", type: "codex" }
    expect(fileBookCode(chronicles)).toBe("1CH")
    expect(filesForBook([...FILES, chronicles], "1CH")).toEqual([chronicles])
  })

  it("does not read a book off the name of a non-scripture file", () => {
    expect(fileBookCode({ name: "ACT", type: "vtt" })).toBeUndefined()
  })
})

describe("sheetBookIds", () => {
  it("reads the book from the reference column, past its header, however it is spelled", () => {
    const rows = [["Reference", "Translation"], ["JON 1:1", "a"], ["Jonah 1:2", "b"], ["jon 1.3", "c"]]
    expect(sheetBookIds(rows)).toEqual(["JON"])
  })

  it("finds the reference column wherever it sits", () => {
    expect(sheetBookIds([["source", "target", "ref"], ["s", "t", "RUT 1:1"], ["s", "t", "RUT 1:2"]])).toEqual(["RUT"])
  })

  it("names every book a sheet holding two covers, in order", () => {
    expect(sheetBookIds([["RUT 4:22", "a"], ["JON 1:1", "b"]])).toEqual(["RUT", "JON"])
  })

  it("does not read a book off a translation that quotes a verse", () => {
    const rows = [["Translation"], ["As John 3:16 says"], ["Something else"], ["More text"]]
    expect(sheetBookIds(rows)).toEqual([])
  })

  it("finds nothing in a sheet without references", () => {
    expect(sheetBookIds([["target"], ["Uno"], ["Dos"]])).toEqual([])
    expect(sheetBookIds([])).toEqual([])
  })
})

describe("uploadBookIds", () => {
  it("reads a USFM file's \\id line", async () => {
    expect(await uploadBookIds(new File(["\\id JON\n\\c 1\n\\v 1 a\n"], "JON-tatar.usfm"))).toEqual(["JON"])
  })

  it("reads a CSV or TSV file's reference column", async () => {
    expect(await uploadBookIds(new File(["Reference,Translation\nJON 1:1,a\nJON 1:2,b\n"], "JON-tatar.csv"))).toEqual(["JON"])
    expect(await uploadBookIds(new File(["ref\ttext\nRUT 1:1\ta\n"], "ruth.tsv"))).toEqual(["RUT"])
  })

  it("finds no book in subtitles, or in a workbook it can't read", async () => {
    expect(await uploadBookIds(new File(["WEBVTT\n\n00:00.000 --> 00:01.000\nJON 1:1\n"], "ep.vtt"))).toEqual([])
    expect(await uploadBookIds(new File(["not a zip"], "broken.xlsx"))).toEqual([])
  })
})

describe("suggestTranslationDestination", () => {
  it("offers the one file that holds the upload's book", () => {
    expect(suggestTranslationDestination(FILES, ["rut"])).toEqual({ kind: "file", bookCode: "RUT", file: RUTH })
  })

  it("offers nothing, and says so, when two files share the book", () => {
    const secondJonah = { ...JONAH, id: "jonah-2", name: "Jonah (2)" }
    expect(suggestTranslationDestination([...FILES, secondJonah], ["JON"])).toEqual({ kind: "several", bookCode: "JON" })
  })

  it("offers nothing, and says so, when no file holds the book", () => {
    expect(suggestTranslationDestination(FILES, ["GEN"])).toEqual({ kind: "none", bookCode: "GEN" })
  })

  it("says nothing for an upload naming no book, or more than one", () => {
    expect(suggestTranslationDestination(FILES, [])).toBeNull()
    expect(suggestTranslationDestination(FILES, ["RUT", "JON"])).toBeNull()
  })
})
