import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { parseEBibleCorpus, __setVrefsForTest } from "./ebible"

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
})
