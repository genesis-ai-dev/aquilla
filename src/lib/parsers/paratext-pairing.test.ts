import { describe, it, expect } from "vitest"
import { pairSourceTarget, buildBilingualPlan, type SourceVerse } from "./paratext-pairing"

const targetMAT = `\\id MAT\n\\c 1\n\\v 1 تارگەت ١\n\\v 2 تارگەت ٢\n\\v 3 تارگەت ٣`
const targetGEN = `\\id GEN\n\\c 1\n\\v 1 in the beginning (target)`

const source: SourceVerse[] = [
  { ref: "GEN 1:1", text: "In the beginning God created" },
  { ref: "MAT 1:1", text: "The book of the genealogy" },
  { ref: "MAT 1:2", text: "Abraham was the father of Isaac" },
  { ref: "MAT 1:4", text: "source-only verse (no target)" },
]

describe("pairSourceTarget", () => {
  it("aligns source and target by verse ref", () => {
    const books = pairSourceTarget([{ bookId: "MAT", rawSource: targetMAT }], source)
    expect(books).toHaveLength(1)
    const mat = books[0]
    const byRef = new Map(mat.rows.map((r) => [r.ref, r]))
    expect(byRef.get("MAT 1:1")).toEqual({
      ref: "MAT 1:1",
      sourceText: "The book of the genealogy",
      targetText: "تارگەت ١",
    })
    expect(byRef.get("MAT 1:2")!.sourceText).toBe("Abraham was the father of Isaac")
    expect(byRef.get("MAT 1:2")!.targetText).toBe("تارگەت ٢")
  })

  it("keeps target-only verses (source blank) — low-resource target ahead of source", () => {
    const books = pairSourceTarget([{ bookId: "MAT", rawSource: targetMAT }], source)
    const v3 = books[0].rows.find((r) => r.ref === "MAT 1:3")!
    expect(v3.targetText).toBe("تارگەت ٣")
    expect(v3.sourceText).toBe("")
  })

  it("keeps source-only verses (target blank) — source fuller than target", () => {
    const books = pairSourceTarget([{ bookId: "MAT", rawSource: targetMAT }], source)
    const v4 = books[0].rows.find((r) => r.ref === "MAT 1:4")!
    expect(v4.sourceText).toBe("source-only verse (no target)")
    expect(v4.targetText).toBe("")
  })

  it("reports alignment counts", () => {
    const mat = pairSourceTarget([{ bookId: "MAT", rawSource: targetMAT }], source)[0]
    expect(mat.bothCount).toBe(2) // 1:1, 1:2
    expect(mat.targetOnlyCount).toBe(1) // 1:3
    expect(mat.sourceOnlyCount).toBe(1) // 1:4
    expect(mat.rows).toHaveLength(4)
  })

  it("orders rows canonically by chapter:verse", () => {
    const mat = pairSourceTarget([{ bookId: "MAT", rawSource: targetMAT }], source)[0]
    expect(mat.rows.map((r) => r.ref)).toEqual(["MAT 1:1", "MAT 1:2", "MAT 1:3", "MAT 1:4"])
  })

  it("orders books canonically (GEN before MAT) and tags corpus", () => {
    const books = pairSourceTarget(
      [
        { bookId: "MAT", rawSource: targetMAT },
        { bookId: "GEN", rawSource: targetGEN },
      ],
      source,
    )
    expect(books.map((b) => b.bookId)).toEqual(["GEN", "MAT"])
    expect(books[0].corpusMarker).toBe("OT")
    expect(books[1].corpusMarker).toBe("NT")
  })

  it("handles a target book with no source coverage (all target-only)", () => {
    const books = pairSourceTarget([{ bookId: "GEN", rawSource: targetGEN }], [])
    expect(books[0].rows).toEqual([
      { ref: "GEN 1:1", sourceText: "", targetText: "in the beginning (target)" },
    ])
    expect(books[0].targetOnlyCount).toBe(1)
  })
})

describe("buildBilingualPlan", () => {
  it("produces one paired cell per verse row, source+target sharing a cellId", () => {
    const plan = buildBilingualPlan([{ bookId: "MAT", rawSource: targetMAT }], source)
    expect(plan).toHaveLength(1)
    const mat = plan[0]
    expect(mat.cells).toHaveLength(4) // MAT 1:1-4 union
    const c1 = mat.cells.find((c) => c.ref === "MAT 1:1")!
    expect(c1.sourceText).toBe("The book of the genealogy")
    expect(c1.targetText).toBe("تارگەت ١")
    expect(c1.cellId).toBeTruthy()
    // cellIds are unique per row
    expect(new Set(mat.cells.map((c) => c.cellId)).size).toBe(mat.cells.length)
  })

  it("carries the target raw bytes as the round-trip side-car", () => {
    const plan = buildBilingualPlan([{ bookId: "MAT", rawSource: targetMAT }], source)
    expect(plan[0].rawSource).toBe(targetMAT)
  })

  it("keeps counts + canonical order + corpus from the pairing", () => {
    const plan = buildBilingualPlan(
      [
        { bookId: "MAT", rawSource: targetMAT },
        { bookId: "GEN", rawSource: targetGEN },
      ],
      source,
    )
    expect(plan.map((b) => b.bookId)).toEqual(["GEN", "MAT"])
    const mat = plan.find((b) => b.bookId === "MAT")!
    expect(mat.bothCount).toBe(2)
    expect(mat.corpusMarker).toBe("NT")
  })
})
