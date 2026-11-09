import { describe, it, expect } from "vitest"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from "./builtin-registry"

describe("builtin-registry", () => {
  it("contains all builtin checks", () => {
    expect(BUILTIN_CHECK_IDS).toEqual([
      "empty-target",
      "target-equals-source",
      "placeholder-integrity",
      "number-integrity",
      "number-integrity-extra",
      "end-punctuation-mismatch",
      "punctuation-integrity",
      "double-space",
      "repeated-word",
      "unpaired-symbols",
      "abbreviation-mismatch",
      "usfm-structure",
      "capitalization",
      "footnote-quote-mismatch",
      "corrupted-characters",
      "unpaired-quotes",
      "untranslated-fragment",
      "length-ratio",
      "scripture-reference",
    ])
  })

  it("each entry has id, name, description, defaultSeverity, defaultEnabled, run, message", () => {
    for (const id of BUILTIN_CHECK_IDS) {
      const def = BUILTIN_CHECKS[id]
      expect(def.id).toBe(id)
      expect(typeof def.name).toBe("string")
      expect(def.name.length).toBeGreaterThan(0)
      expect(typeof def.description).toBe("string")
      expect(["major", "minor"]).toContain(def.defaultSeverity)
      expect(typeof def.defaultEnabled).toBe("boolean")
      expect(typeof def.run).toBe("function")
      // message is static copy, or a builder deriving copy from spans (FRO-345)
      expect(["string", "function"]).toContain(typeof def.message)
    }
  })

  // length-ratio is off because normal length varies too much by language pair;
  // scripture-reference (AQU-1735) because its book-name half needs the
  // project's own book names first.
  it("only abbreviation-mismatch, length-ratio and scripture-reference are off by default", () => {
    const off = new Set(["abbreviation-mismatch", "length-ratio", "scripture-reference"])
    for (const id of BUILTIN_CHECK_IDS) {
      const def = BUILTIN_CHECKS[id]
      expect(def.defaultEnabled).toBe(!off.has(id))
    }
  })

  it("dispatches run() correctly", () => {
    expect(BUILTIN_CHECKS["empty-target"].run("hello", "")).not.toBeNull()
    expect(BUILTIN_CHECKS["empty-target"].run("hello", "world")).toBeNull()
  })
})
