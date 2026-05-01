import { describe, it, expect } from "vitest"
import { resolveBuiltinRules } from "./builtin-resolver"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from "./builtin-registry"

describe("resolveBuiltinRules", () => {
  it("returns one rule per registry entry by default", () => {
    const rules = resolveBuiltinRules(undefined)
    expect(rules.length).toBe(BUILTIN_CHECK_IDS.length)
    for (const id of BUILTIN_CHECK_IDS) {
      const r = rules.find((x) => x.id === `builtin:${id}`)
      expect(r).toBeTruthy()
      expect(r!.check).toEqual({ type: "builtin", checkId: id })
      expect(r!.enabled).toBe(BUILTIN_CHECKS[id].defaultEnabled)
      expect(r!.severity).toBe(BUILTIN_CHECKS[id].defaultSeverity)
      expect(r!.source).toBe("algorithmic")
    }
  })

  it("override flips enabled flag", () => {
    const rules = resolveBuiltinRules({
      "abbreviation-mismatch": { enabled: true },
    })
    const r = rules.find((x) => x.id === "builtin:abbreviation-mismatch")!
    expect(r.enabled).toBe(true)
  })

  it("override sets severity", () => {
    const rules = resolveBuiltinRules({
      "double-space": { enabled: true, severity: "major" },
    })
    const r = rules.find((x) => x.id === "builtin:double-space")!
    expect(r.severity).toBe("major")
  })

  it("missing override falls back to defaults", () => {
    const rules = resolveBuiltinRules({
      "double-space": { enabled: false },
    })
    const r = rules.find((x) => x.id === "builtin:end-punctuation-mismatch")!
    expect(r.enabled).toBe(BUILTIN_CHECKS["end-punctuation-mismatch"].defaultEnabled)
  })
})
