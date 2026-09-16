// AQU-1278. Which verses a chapter card lists, and what each chip says. How
// many chips FIT is no longer anybody's question: the row scrolls.

import { describe, expect, it } from "vitest"
import { shortVerses, verseChipLabel } from "./verse-chips"

const verse = (cellId: string, ref: string, over: Partial<{ filled: boolean; validated: boolean }> = {}) =>
  ({ cellId, ref, filled: true, validated: true, ...over })

describe("which verses are short", () => {
  const verses = [
    verse("c1", "GEN 12:1"),
    verse("c2", "GEN 12:2", { validated: false }),
    verse("c3", "GEN 12:3", { filled: false, validated: false }),
  ]

  it("lists the unwritten ones when translation leads", () => {
    // A cell nobody has written cannot be validated, so a chip pointing at an
    // unvalidated cell would send a reader to do the other job first.
    expect(shortVerses(verses, "untranslated").map((v) => v.cellId)).toEqual(["c3"])
  })

  it("lists the unvalidated ones otherwise, and never the unwritten", () => {
    expect(shortVerses(verses, "unvalidated").map((v) => v.cellId)).toEqual(["c2"])
  })

  it("keeps the server's canonical order", () => {
    const many = [verse("a", "GEN 12:9", { validated: false }), verse("b", "GEN 12:10", { validated: false })]
    expect(shortVerses(many, "unvalidated").map((v) => v.cellId)).toEqual(["a", "b"])
  })
})

describe("what a chip prints", () => {
  it("drops the book, because the card title and the panel header both say it", () => {
    expect(verseChipLabel("GEN 12:4", "GEN 12")).toBe("12:4")
  })

  it("keeps the verse alone for a one-chapter book with no chapter in its refs", () => {
    expect(verseChipLabel("TIT:4", "TIT")).toBe("4")
  })

  it("still strips the book from a ref that is not this section's shape", () => {
    expect(verseChipLabel("GEN 12:4", "GEN 13")).toBe("12:4")
  })

  it("falls back to the whole ref rather than inventing a number", () => {
    expect(verseChipLabel("Scene 4 opening", "Scene 4")).toBe("Scene 4 opening")
  })
})

describe("which verses are short — audio", () => {
  const rec = (cellId: string, recorded: boolean, audioValidated = false) =>
    ({ ...verse(cellId, `GEN 1:${cellId}`), recorded, audioValidated })

  it("lists the verses with no take for an unrecorded lead", () => {
    expect(shortVerses([rec("1", true), rec("2", false), rec("3", false)], "unrecorded").map((v) => v.cellId))
      .toEqual(["2", "3"])
  })

  it("lists recorded takes nobody has signed off for an unsigned lead", () => {
    expect(shortVerses([rec("1", true, true), rec("2", true), rec("3", false)], "unsigned").map((v) => v.cellId))
      .toEqual(["2"])
  })

  it("lists nothing for an audio lead when the verses carry no take state", () => {
    // An older worker sends neither flag; unknown is not outstanding.
    expect(shortVerses([verse("1", "GEN 1:1"), verse("2", "GEN 1:2")], "unrecorded")).toEqual([])
    expect(shortVerses([verse("1", "GEN 1:1")], "unsigned")).toEqual([])
  })
})
