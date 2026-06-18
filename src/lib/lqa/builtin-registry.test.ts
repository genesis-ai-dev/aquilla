import { describe, it, expect } from "vitest"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from "./builtin-registry"

describe("builtin-registry", () => {
  it("contains all builtin checks", () => {
    expect(BUILTIN_CHECK_IDS).toEqual([
      "empty-target",
      "target-equals-source",
      "placeholder-integrity",
      "number-integrity",
      "end-punctuation-mismatch",
      "double-space",
      "repeated-word",
      "unpaired-symbols",
      "abbreviation-mismatch",
      "usfm-marker-integrity",
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
      expect(typeof def.message).toBe("string")
    }
  })

  it("only abbreviation-mismatch is off by default", () => {
    for (const id of BUILTIN_CHECK_IDS) {
      const def = BUILTIN_CHECKS[id]
      if (id === "abbreviation-mismatch") expect(def.defaultEnabled).toBe(false)
      else expect(def.defaultEnabled).toBe(true)
    }
  })

  it("dispatches run() correctly", () => {
    expect(BUILTIN_CHECKS["empty-target"].run("hello", "")).not.toBeNull()
    expect(BUILTIN_CHECKS["empty-target"].run("hello", "world")).toBeNull()
  })
})
