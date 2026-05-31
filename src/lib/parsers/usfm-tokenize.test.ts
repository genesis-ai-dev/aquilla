import { describe, it, expect } from "vitest"
import { tokenizeUsfm, classifyRuns, analyzeCoverage } from "./usfm-tokenize"

const SAMPLE = `\\id MAT Test
\\h Matthew
\\toc1 The Gospel of Matthew
\\mt1 Matthew
\\c 1
\\s The Genealogy
\\p
\\v 1 In the beginning\\f + \\fr 1:1 \\ft A footnote.\\f* God created \\nd LORD\\nd* the heavens.
\\v 2 More text.\\x - \\xo 1:2 \\xt Gen 1.1\\x* After the xref.
\\q1 a poetry line`

describe("tokenizeUsfm", () => {
  it("partitions the input exactly (reassembly == original)", () => {
    const tokens = tokenizeUsfm(SAMPLE)
    expect(tokens.map((t) => (t.type === "marker" ? t.raw : t.text)).join("")).toBe(SAMPLE)
  })
  it("recognizes end markers and nested markers", () => {
    const tokens = tokenizeUsfm("\\v 1 a\\+nd b\\+nd*\\f x\\f*")
    const markers = tokens.filter((t) => t.type === "marker") as Extract<ReturnType<typeof tokenizeUsfm>[number], { type: "marker" }>[]
    const nd = markers.find((m) => m.raw === "\\+nd")!
    expect(nd.nested).toBe(true)
    expect(nd.name).toBe("nd")
    expect(markers.find((m) => m.raw === "\\f*")!.isEnd).toBe(true)
  })
})

describe("classifyRuns", () => {
  const runs = classifyRuns(SAMPLE)
  const translatable = runs.filter((r) => r.kind === "translatable")
  const texts = translatable.map((r) => r.text)

  it("captures verse body text", () => {
    expect(texts).toContain("In the beginning")
    expect(texts).toContain("God created")
    expect(texts).toContain("the heavens.")
  })
  it("captures divine-name content as verse body (inline char marker)", () => {
    expect(texts).toContain("LORD")
  })
  it("captures footnote text (\\ft) as a separate translatable run, NOT the ref (\\fr)", () => {
    const ft = translatable.find((r) => r.text === "A footnote.")
    expect(ft).toBeTruthy()
    expect(ft!.role).toBe("footnote-text")
    expect(ft!.unit).toContain("#f1")
    // The \fr ref "1:1" must NOT be translatable.
    expect(texts).not.toContain("1:1")
  })
  it("treats cross-ref origin (\\xo) as reference, target (\\xt) as translatable", () => {
    const refRuns = runs.filter((r) => r.kind === "reference").map((r) => r.text)
    expect(refRuns).toContain("1:2")            // \xo origin
    expect(texts).toContain("Gen 1.1")          // \xt target (book names get localized)
  })
  it("captures headings + titles as translatable", () => {
    expect(texts).toContain("The Genealogy")    // \s
    expect(texts).toContain("Matthew")          // \h and \mt1
    expect(texts).toContain("The Gospel of Matthew") // \toc1
  })
  it("treats verse/chapter numbers as numbers, \\id body as metadata", () => {
    expect(runs.find((r) => r.role === "verse-number" && r.text === "1")).toBeTruthy()
    expect(runs.find((r) => r.role === "chapter-number" && r.text === "1")).toBeTruthy()
    expect(runs.find((r) => r.kind === "metadata" && r.text.includes("MAT"))).toBeTruthy()
  })
})

describe("analyzeCoverage", () => {
  it("round-trips and partitions the sample with zero orphaned translatable runs", () => {
    const rep = analyzeCoverage(SAMPLE)
    expect(rep.roundTrips).toBe(true)
    expect(rep.partitions).toBe(true)
    expect(rep.orphanedTranslatable).toHaveLength(0)
    // Sanity: byte counts sum to total.
    const sum = Object.values(rep.bytesByKind).reduce((a, b) => a + b, 0)
    expect(sum).toBe(rep.totalBytes)
  })

  it("every translatable run is attributed to a unit", () => {
    const rep = analyzeCoverage(SAMPLE)
    for (const r of rep.translatableRuns) expect(r.unit).not.toBe("")
  })
})
