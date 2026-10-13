import { describe, expect, it } from "vitest"
import {
  BIG_BIBLE_CELL_COUNT,
  TOTAL_BOOKS,
  TOTAL_CHAPTERS,
  planBigBible,
} from "./big-bible-plan"

describe("planBigBible", () => {
  it("is the production shape: 66 files over the canon's 1,189 chapters", () => {
    const plan = planBigBible()
    expect(TOTAL_BOOKS).toBe(66)
    expect(TOTAL_CHAPTERS).toBe(1_189)
    expect(plan.files).toHaveLength(66)
    expect(plan.stats.chapters).toBe(1_189)
    expect(plan.files.map((file) => file.bookCode).slice(0, 3)).toEqual(["GEN", "EXO", "LEV"])
    expect(plan.files.at(-1)?.bookCode).toBe("REV")
  })

  it("hits the requested cell total exactly, so two runs are comparable", () => {
    expect(planBigBible().stats.cells).toBe(BIG_BIBLE_CELL_COUNT)
    expect(planBigBible({ targetCells: 20_000 }).stats.cells).toBe(20_000)
    expect(planBigBible({ targetCells: 4_000 }).stats.cells).toBe(4_000)
  })

  it("accounts for every cell as a heading or a verse", () => {
    const plan = planBigBible({ targetCells: 10_000 })
    expect(plan.stats.headings).toBe(TOTAL_BOOKS + TOTAL_CHAPTERS)
    expect(plan.stats.headings + plan.stats.verses).toBe(plan.stats.cells)
  })

  it("is deterministic — same seed, byte-identical plan", () => {
    expect(planBigBible({ targetCells: 3_000 })).toEqual(planBigBible({ targetCells: 3_000 }))
  })

  it("changes content, not shape, when the seed changes", () => {
    const a = planBigBible({ targetCells: 3_000, seed: 1 })
    const b = planBigBible({ targetCells: 3_000, seed: 2 })
    expect(b.stats.cells).toBe(a.stats.cells)
    expect(b.files[0].cells[2].text).not.toBe(a.files[0].cells[2].text)
  })

  it("gives every cell in the project a unique id", () => {
    const plan = planBigBible({ targetCells: 8_000 })
    const ids = plan.files.flatMap((file) => file.cells.map((cell) => cell.cellId))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("marks headings as headings and verses with a canonical ref", () => {
    const genesis = planBigBible({ books: 1, targetCells: 1_000 }).files[0]
    expect(genesis.cells[0]).toMatchObject({ cellId: "GEN title", type: "heading", canonicalRef: null })
    expect(genesis.cells[1]).toMatchObject({ cellId: "GEN 1:0", type: "heading" })
    expect(genesis.cells[2]).toMatchObject({ cellId: "GEN 1:1", type: null, canonicalRef: "GEN 1:1" })
  })

  it("translates roughly the requested fraction of verses, second lane a subset", () => {
    const plan = planBigBible({ targetCells: 20_000, translatedFraction: 0.35, secondLaneFraction: 0.4 })
    const ratio = plan.stats.translated / plan.stats.verses
    expect(ratio).toBeGreaterThan(0.3)
    expect(ratio).toBeLessThan(0.4)
    expect(plan.stats.secondLane).toBeLessThan(plan.stats.translated)
    expect(plan.stats.secondLane).toBeGreaterThan(0)
  })

  it("never gives a heading target text — headings are not translated cells", () => {
    const plan = planBigBible({ targetCells: 5_000 })
    const headings = plan.files.flatMap((file) => file.cells.filter((cell) => cell.type === "heading"))
    expect(headings.every((cell) => cell.targetText === null && cell.secondLaneText === null)).toBe(true)
  })

  it("can be shrunk to a few books for a seeder smoke test", () => {
    const plan = planBigBible({ books: 2, targetCells: 500 })
    expect(plan.files.map((file) => file.bookCode)).toEqual(["GEN", "EXO"])
    expect(plan.stats.cells).toBe(500)
  })

  it("stays structurally valid when asked for fewer cells than there are chapters", () => {
    const plan = planBigBible({ targetCells: 1 })
    expect(plan.stats.verses).toBe(TOTAL_CHAPTERS)
    expect(plan.stats.cells).toBe(TOTAL_BOOKS + TOTAL_CHAPTERS * 2)
  })
})
