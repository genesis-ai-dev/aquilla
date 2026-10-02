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
      "punctuation-integrity",
      "double-space",
      "repeated-word",
      "unpaired-symbols",
      "abbreviation-mismatch",
      "reference-quote",
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

  it("reference-quote is a minor warning that needs the lane's Bible from the context (AQU-1573)", () => {
    const def = BUILTIN_CHECKS["reference-quote"]
    expect(def.defaultSeverity).toBe("minor")
    expect(def.runsOnEmptyTarget).toBe(false)
    const source = "\"For God so loved the world\" (John 3:16)"
    const draft = "For God so loved the whole world, that he gave his only begotten Son"
    expect(def.run(source, draft)).toBeNull()
    const ctx = {
      referenceBible: {
        versionName: "King James Version",
        lookup: () => ["For God so loved the world, that he gave his only begotten Son"],
      },
    }
    expect(def.run(source, draft, ctx)).toMatchObject({ params: { kind: "differs", refs: "John 3:16" } })
  })
})
