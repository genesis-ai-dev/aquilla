// AQU-1278. The overflow rule is tested HERE rather than through the component
// because happy-dom reports every width as zero and has no ResizeObserver, so a
// rendered chapter card can only ever exercise the unmeasured path.

import { describe, expect, it } from "vitest"
import {
  VERSE_CHIP_GAP_PX,
  VERSE_CHIP_PX,
  shortVerses,
  verseChipLabel,
  verseChipSplit,
  verseChipsThatFit,
} from "./verse-chips"

const verse = (cellId: string, ref: string, over: Partial<{ filled: boolean; validated: boolean }> = {}) =>
  ({ cellId, ref, filled: true, validated: true, ...over })

describe("how many chips fit", () => {
  it("fits one chip in its own width, and none below it", () => {
    expect(verseChipsThatFit(VERSE_CHIP_PX)).toBe(1)
    expect(verseChipsThatFit(VERSE_CHIP_PX - 1)).toBe(0)
  })

  it("charges every chip after the first for its gap as well", () => {
    expect(verseChipsThatFit(VERSE_CHIP_PX * 3 + VERSE_CHIP_GAP_PX * 2)).toBe(3)
    // One pixel short of the third chip is two chips, not two and a bit.
    expect(verseChipsThatFit(VERSE_CHIP_PX * 3 + VERSE_CHIP_GAP_PX * 2 - 1)).toBe(2)
  })

  it("takes an unmeasured row as unbounded", () => {
    // The row starts at Infinity so it draws every chip until a measurement
    // lands. Starting at zero would flash a bare "+7" on every open.
    expect(verseChipsThatFit(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("splitting the chips from the count", () => {
  it("draws them all when they fit", () => {
    expect(verseChipSplit(3, 5)).toEqual({ shown: 3, overflow: 0 })
    expect(verseChipSplit(3, 3)).toEqual({ shown: 3, overflow: 0 })
  })

  it("reserves a slot for the count the moment one is needed", () => {
    // Four verses into three slots is TWO chips and a "+2", never three chips
    // and a hidden fourth — the row must never understate how much is left.
    expect(verseChipSplit(4, 3)).toEqual({ shown: 2, overflow: 2 })
  })

  it("spends its last slot on the count, not on one arbitrary verse", () => {
    // A single verse out of seven is the least useful thing a last slot could
    // say. The same rule the board's avatar strip follows.
    expect(verseChipSplit(7, 1)).toEqual({ shown: 0, overflow: 7 })
  })

  it("draws nothing for nothing", () => {
    expect(verseChipSplit(0, 5)).toEqual({ shown: 0, overflow: 0 })
  })
})

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
