import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  checkUsfmStructure,
  checkUsfmMarkers,
  looksLikeUsfm,
  type UsfmStructureCode,
} from "./usfm-structure-check"

const codes = (raw: string): UsfmStructureCode[] => checkUsfmStructure(raw).map((f) => f.code)
const find = (raw: string, code: UsfmStructureCode) =>
  checkUsfmStructure(raw).filter((f) => f.code === code)

describe("checkUsfmStructure — chapter/verse numbering", () => {
  it("accepts a well-formed book", () => {
    expect(
      codes(`\\id GEN\n\\c 1\n\\p\n\\v 1 In the beginning.\n\\v 2 The earth.\n\\c 2\n\\p\n\\v 1 Thus.\n`),
    ).toEqual([])
  })

  it("reports a gap in the verse sequence with its ref", () => {
    const gaps = find(`\\id GEN\n\\c 1\n\\p\n\\v 1 One.\n\\v 4 Four.\n`, "verse-missing")
    expect(gaps.map((f) => f.ref)).toEqual(["GEN 1:2", "GEN 1:3"])
    expect(gaps[0].severity).toBe("warning")
  })

  it("reports a verse sequence that does not start at 1", () => {
    expect(find(`\\id GEN\n\\c 1\n\\p\n\\v 3 Three.\n`, "verse-missing").map((f) => f.ref)).toEqual([
      "GEN 1:1",
      "GEN 1:2",
    ])
  })

  it("reports a duplicate verse with its ref", () => {
    const dup = find(`\\id GEN\n\\c 1\n\\p\n\\v 1 One.\n\\v 2 Two.\n\\v 2 Again.\n`, "verse-duplicate")
    expect(dup).toHaveLength(1)
    expect(dup[0].ref).toBe("GEN 1:2")
    expect(dup[0].severity).toBe("error")
  })

  it("reports a verse that steps backwards", () => {
    const back = find(`\\id GEN\n\\c 1\n\\p\n\\v 1 One.\n\\v 5 Five.\n\\v 3 Three.\n`, "verse-out-of-order")
    expect(back).toHaveLength(1)
    expect(back[0].ref).toBe("GEN 1:3")
  })

  it("counts a verse bridge as covering both ends", () => {
    expect(codes(`\\id GEN\n\\c 1\n\\p\n\\v 1-2 Both.\n\\v 3 Three.\n`)).toEqual([])
  })

  it("accepts a lettered verse part", () => {
    expect(codes(`\\id GEN\n\\c 1\n\\p\n\\v 1a Part.\n\\v 2 Two.\n`)).toEqual([])
  })

  it("reports a missing, duplicate and out-of-order chapter", () => {
    const raw = `\\id GEN\n\\c 1\n\\p\n\\v 1 a\n\\c 3\n\\p\n\\v 1 b\n\\c 3\n\\p\n\\v 1 c\n\\c 2\n\\p\n\\v 1 d\n`
    expect(find(raw, "chapter-missing").map((f) => f.ref)).toEqual(["GEN 2"])
    expect(find(raw, "chapter-duplicate").map((f) => f.ref)).toEqual(["GEN 3"])
    expect(find(raw, "chapter-out-of-order").map((f) => f.ref)).toEqual(["GEN 2"])
  })

  it("restarts verse numbering at each chapter", () => {
    expect(codes(`\\id GEN\n\\c 1\n\\p\n\\v 1 a\n\\v 2 b\n\\c 2\n\\p\n\\v 1 c\n`)).toEqual([])
  })

  it("reports a verse marker before any chapter", () => {
    const stray = find(`\\id GEN\n\\p\n\\v 1 Stray.\n`, "verse-outside-chapter")
    expect(stray).toHaveLength(1)
    expect(stray[0].ref).toBe("GEN")
  })

  it("reports a non-numeric verse number", () => {
    expect(find(`\\id GEN\n\\c 1\n\\p\n\\v one Text.\n`, "verse-invalid")).toHaveLength(1)
  })

  it("reports a blank chapter number", () => {
    expect(find(`\\id GEN\n\\c\n\\p\n`, "chapter-invalid")).toHaveLength(1)
  })

  it("does not read \\cl, \\cp or \\va as chapter/verse numbers", () => {
    expect(
      codes(`\\id PSA\n\\c 1\n\\cl Psalm 1\n\\cp A\n\\p\n\\v 1 a\\va 2\\va*\n\\v 2 b\n`),
    ).toEqual([])
  })
})

describe("checkUsfmStructure — markers", () => {
  it("reports an unclosed footnote at the ref it opened on", () => {
    const raw = `\\id GEN\n\\c 1\n\\p\n\\v 1 One.\\f + \\ft A note.\n\\v 2 Two.\n`
    const unclosed = find(raw, "marker-unclosed")
    expect(unclosed).toHaveLength(1)
    expect(unclosed[0].ref).toBe("GEN 1:1")
    expect(unclosed[0].detail).toBe("\\f")
    expect(unclosed[0].severity).toBe("error")
  })

  it("accepts a closed footnote and cross-reference", () => {
    expect(
      codes(
        `\\id GEN\n\\c 1\n\\p\n\\v 1 One.\\f + \\fr 1.1 \\ft A note.\\f*\n` +
          `\\v 2 Two.\\x - \\xo 1:2 \\xt Exo 1:1\\x*\n`,
      ),
    ).toEqual([])
  })

  it("reports an end marker with no opening marker", () => {
    const orphan = find(`\\id GEN\n\\c 1\n\\p\n\\v 1 One.\\nd*\n`, "marker-unopened")
    expect(orphan).toHaveLength(1)
    expect(orphan[0].detail).toBe("\\nd*")
  })

  it("accepts a nested character marker pair", () => {
    expect(codes(`\\id GEN\n\\c 1\n\\p\n\\v 1 \\add an \\+nd Lord\\+nd* addition\\add*\n`)).toEqual([])
  })

  it("reports an unknown marker with its ref", () => {
    const unknown = find(`\\id GEN\n\\c 1\n\\p\n\\v 1 One.\\bogus text\n`, "marker-unknown")
    expect(unknown).toHaveLength(1)
    expect(unknown[0].ref).toBe("GEN 1:1")
    expect(unknown[0].detail).toBe("\\bogus")
  })

  it("tolerates the z custom namespace and milestone markers", () => {
    expect(
      codes(`\\id GEN\n\\c 1\n\\ts\\*\n\\p\n\\v 1 \\zaln-s |x-content="x"\\*\\w One|x-occ="1"\\w*\\zaln-e\\*\n`),
    ).toEqual([])
  })

  it("reports mixing a bare marker with its numbered variant", () => {
    const mixed = find(`\\id PSA\n\\c 1\n\\q Bare.\n\\q1 Numbered.\n\\p\n\\v 1 a\n`, "marker-level-mixed")
    expect(mixed).toHaveLength(1)
    expect(mixed[0].detail).toBe("\\q and \\q1")
  })

  it("accepts consistent numbered levels", () => {
    expect(codes(`\\id PSA\n\\c 1\n\\p\n\\v 1 a\n\\q1 b\n\\q2 c\n\\q1 d\n`)).toEqual([])
  })

  it("reports an introduction marker after the first chapter", () => {
    const late = find(`\\id GEN\n\\c 1\n\\p\n\\v 1 a\n\\ip Intro text.\n`, "marker-after-chapter")
    expect(late).toHaveLength(1)
    expect(late[0].detail).toBe("\\ip")
  })

  it("reports a missing verse, a duplicate verse and an unclosed \\f together", () => {
    // The ticket's first acceptance criterion, in one file.
    const raw =
      `\\id GEN\n\\c 1\n\\p\n` +
      `\\v 1 One.\\f + \\ft Unclosed note.\n` +
      `\\v 3 Three.\n` +
      `\\v 3 Three again.\n`
    const got = checkUsfmStructure(raw)
    expect(got.filter((f) => f.code === "verse-missing").map((f) => f.ref)).toEqual(["GEN 1:2"])
    expect(got.filter((f) => f.code === "verse-duplicate").map((f) => f.ref)).toEqual(["GEN 1:3"])
    expect(got.filter((f) => f.code === "marker-unclosed").map((f) => f.ref)).toEqual(["GEN 1:1"])
  })
})

describe("real files produce zero findings", () => {
  // AQU-1731 AC: "Clean Biblica sample files produce zero findings." The
  // aligned unfoldingWord fixtures are the most marker-dense real USFM in the
  // repo (\zaln-s/\zaln-e milestones, \w pairs, \ts\*), so they are the
  // strictest available false-positive guard.
  it.each([
    "src/lib/parsers/__fixtures__/ult-tit-1.usfm",
    "src/lib/parsers/__fixtures__/ult-psa-1.usfm",
    "src/lib/parsers/__fixtures__/uhb-exo-1.usfm",
    "e2e/fixtures/sample.usfm",
  ])("%s", (path) => {
    expect(checkUsfmStructure(readFileSync(path, "utf8"))).toEqual([])
  })
})

describe("checkUsfmMarkers — the per-cell subset", () => {
  it("keeps marker findings and drops numbering findings", () => {
    // A cell's text has no \c/\v spine, so a bare verse run would otherwise
    // read as "verse outside chapter" on every single cell.
    const cell = `One.\\f + \\ft Unclosed.`
    expect(checkUsfmMarkers(cell).map((f) => f.code)).toEqual(["marker-unclosed"])
  })

  it("is silent on clean cell text", () => {
    expect(checkUsfmMarkers(`\\nd Lord\\nd* said \\add to them\\add*.`)).toEqual([])
  })
})

describe("looksLikeUsfm", () => {
  it("is false for plain prose and for software strings with escapes", () => {
    expect(looksLikeUsfm("In the beginning God created.")).toBe(false)
    expect(looksLikeUsfm("Line one\\nLine two")).toBe(false)
    expect(looksLikeUsfm("C:\\temp\\file")).toBe(false)
  })

  it("is true once a modelled marker appears", () => {
    expect(looksLikeUsfm(`\\nd Lord\\nd*`)).toBe(true)
    expect(looksLikeUsfm(`One.\\f + \\ft note\\f*`)).toBe(true)
  })
})
