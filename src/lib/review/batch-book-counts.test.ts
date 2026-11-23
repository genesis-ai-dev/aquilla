import { describe, expect, it } from "vitest"
import {
  bookCountsFromProgress,
  totalsForCheckedBooks,
  withLiveUntouchedAi,
} from "./batch-book-counts"

describe("bookCountsFromProgress", () => {
  it("splits unvalidated cells from untouched drafts when the draft count is known", () => {
    expect(bookCountsFromProgress({
      total: 100, translated: 40, validated: 10, aiDrafted: 5,
    })).toEqual({ empty: 60, untouchedAi: 5, unsigned: 25 })
  })

  it("keeps the draft count unknown rather than calling it zero", () => {
    expect(bookCountsFromProgress({ total: 10, translated: 4, validated: 1 }))
      .toEqual({ empty: 6, untouchedAi: null, unsigned: 3 })
  })

  it("treats a real zero of drafts as known", () => {
    expect(bookCountsFromProgress({
      total: 10, translated: 4, validated: 1, aiDrafted: 0,
    })?.untouchedAi).toBe(0)
  })
})

describe("totalsForCheckedBooks", () => {
  const counts = new Map([
    ["gen", { empty: 10, untouchedAi: 2, unsigned: 4 }],
    ["exo", { empty: 3, untouchedAi: 1, unsigned: 5 }],
    ["lev", { empty: 8, untouchedAi: null, unsigned: 6 }],
  ])

  it("adds only the books that are checked", () => {
    expect(totalsForCheckedBooks(
      [{ id: "gen" }, { id: "exo" }, { id: "lev" }],
      new Set(["gen", "exo"]),
      counts,
    )).toEqual({ empty: 13, untouchedAi: 3, unsigned: 9 })
  })

  it("returns zeros when nothing is checked", () => {
    expect(totalsForCheckedBooks([{ id: "gen" }], new Set(), counts))
      .toEqual({ empty: 0, untouchedAi: 0, unsigned: 0 })
  })

  it("refuses a draft total when any checked book does not know its drafts", () => {
    expect(totalsForCheckedBooks(
      [{ id: "gen" }, { id: "lev" }],
      new Set(["gen", "lev"]),
      counts,
    )).toEqual({ empty: 18, untouchedAi: null, unsigned: 10 })
  })

  it("returns nothing while a checked book has no rollup", () => {
    expect(totalsForCheckedBooks([{ id: "num" }], new Set(["num"]), counts)).toBeNull()
  })
})

describe("withLiveUntouchedAi", () => {
  it("replaces a stale draft count and keeps those cells out of the unsigned total", () => {
    expect(withLiveUntouchedAi(
      { empty: 60, untouchedAi: 5, unsigned: 25 },
      8,
    )).toEqual({ empty: 60, untouchedAi: 8, unsigned: 22 })
  })

  it("splits drafts out of an unvalidated total that had not separated them", () => {
    expect(withLiveUntouchedAi(
      { empty: 6, untouchedAi: null, unsigned: 3 },
      1,
    )).toEqual({ empty: 6, untouchedAi: 1, unsigned: 2 })
  })
})
