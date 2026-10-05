// AQU-1365: where a dropped translation goes. WHY: the open file is the
// default, a USFM file's own book may move it there only while the person has
// not chosen, and an ambiguous book (two \id lines, two files of one book)
// must never pick silently.
import { describe, expect, it } from "vitest"
import { fileBookCode } from "@/lib/sidebar/group-by-corpus"
import {
  filesForBook,
  isUsfmFileName,
  pickTranslationDestination,
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

describe("pickTranslationDestination", () => {
  it("moves to the upload's book while the person has not chosen", () => {
    expect(pickTranslationDestination({ files: FILES, current: "jonah", touched: false, uploadBookIds: ["RUT"] }))
      .toEqual({ id: "ruth", autoPicked: true })
  })

  it("keeps the person's own choice", () => {
    expect(pickTranslationDestination({ files: FILES, current: "jonah", touched: true, uploadBookIds: ["RUT"] }))
      .toEqual({ id: "jonah", autoPicked: false })
  })

  it("does not call it a switch when the open file already is that book", () => {
    expect(pickTranslationDestination({ files: FILES, current: "jonah", touched: false, uploadBookIds: ["JON"] }))
      .toEqual({ id: "jonah", autoPicked: false })
  })

  it("picks nothing new when two files share the book", () => {
    const secondJonah = { ...JONAH, id: "jonah-2", name: "Jonah (2)" }
    expect(pickTranslationDestination({ files: [...FILES, secondJonah], current: "ruth", touched: false, uploadBookIds: ["JON"] }))
      .toEqual({ id: "ruth", autoPicked: false })
    expect(pickTranslationDestination({ files: [...FILES, secondJonah], current: null, touched: false, uploadBookIds: ["JON"] }))
      .toBeNull()
  })

  it("picks nothing new for a file holding two books", () => {
    expect(pickTranslationDestination({ files: FILES, current: "ep1", touched: false, uploadBookIds: ["RUT", "JON"] }))
      .toEqual({ id: "ep1", autoPicked: false })
  })

  it("keeps the current file when no project file has the book", () => {
    expect(pickTranslationDestination({ files: FILES, current: "jonah", touched: false, uploadBookIds: ["GEN"] }))
      .toEqual({ id: "jonah", autoPicked: false })
  })

  it("picks the book's file when nothing was chosen yet", () => {
    expect(pickTranslationDestination({ files: FILES, current: null, touched: false, uploadBookIds: ["RUT"] }))
      .toEqual({ id: "ruth", autoPicked: true })
  })

  it("holds the upload when nothing is chosen and the book does not decide", () => {
    expect(pickTranslationDestination({ files: FILES, current: null, touched: false, uploadBookIds: [] })).toBeNull()
  })

  it("ignores a current file that is no longer in the project", () => {
    expect(pickTranslationDestination({ files: FILES, current: "gone", touched: true, uploadBookIds: [] })).toBeNull()
  })
})
