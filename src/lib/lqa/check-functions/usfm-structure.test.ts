import { describe, it, expect } from "vitest"
import { runCheck } from "./usfm-structure"

describe("usfm-structure builtin check", () => {
  it("flags an unclosed footnote in the translation", () => {
    const spans = runCheck("One.\\f + \\ft note\\f*", "Un.\\f + \\ft note")
    expect(spans).toHaveLength(1)
    expect(spans?.[0].side).toBe("target")
    expect(spans?.[0].matchedText).toBe("\\f")
  })

  it("flags an end marker with no opening marker", () => {
    const spans = runCheck("\\nd Lord\\nd*", "\\nd Seigneur\\nd*\\nd*")
    expect(spans?.map((s) => s.matchedText)).toEqual(["\\nd*"])
  })

  it("flags an unrecognized marker", () => {
    const spans = runCheck("\\nd Lord\\nd*", "\\nd Seigneur\\nd* \\bogus x")
    expect(spans?.map((s) => s.matchedText)).toEqual(["\\bogus"])
  })

  it("passes a well-formed USFM translation", () => {
    expect(runCheck("\\nd Lord\\nd* said", "\\nd Seigneur\\nd* dit")).toBeNull()
    expect(runCheck("One.\\f + \\ft note\\f*", "Un.\\f + \\ft note\\f*")).toBeNull()
  })

  it("spans point at the offending marker inside the target", () => {
    const target = "Un deux\\bogus trois"
    const spans = runCheck("\\nd Lord\\nd*", target)
    expect(spans).toHaveLength(1)
    expect(target.slice(spans![0].start, spans![0].end)).toBe("\\bogus")
  })

  it("skips cells that are not USFM, so escapes in software strings are safe", () => {
    // The guard that keeps this check off non-scripture projects: neither side
    // carries a marker the taxonomy models, so the cell is not inspected.
    expect(runCheck("Line one\\nLine two", "Ligne un\\nLigne deux")).toBeNull()
    expect(runCheck("Save to C:\\temp", "Enregistrer dans C:\\temp")).toBeNull()
    expect(runCheck("Hello {name}", "Bonjour {name}")).toBeNull()
  })

  it("skips an empty target — that is empty-target's finding, not this one", () => {
    expect(runCheck("\\nd Lord\\nd*", "")).toBeNull()
    expect(runCheck("\\nd Lord\\nd*", "   ")).toBeNull()
  })
})
