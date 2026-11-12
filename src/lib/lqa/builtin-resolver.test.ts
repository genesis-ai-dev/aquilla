import { describe, it, expect } from "vitest"
import { resolveBuiltinRules, withBuiltinOverrides } from "./builtin-resolver"
import { resolvePunctuation } from "../../../db/shared/punctuation-conventions"
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

// AQU-1906: re-resolving a built list against another lane's overrides.
describe("withBuiltinOverrides", () => {
  const base = resolveBuiltinRules({ "double-space": { enabled: false, severity: "major" } })

  it("re-reads the registry defaults, so dropping an override restores the default", () => {
    const off = base.find((r) => r.id === "builtin:double-space")!
    expect(off.enabled).toBe(false)
    expect(off.severity).toBe("major")
    const restored = withBuiltinOverrides(base, undefined).find((r) => r.id === "builtin:double-space")!
    expect(restored.enabled).toBe(true)
    expect(restored.severity).toBe("minor")
  })

  it("applies the overrides it is given", () => {
    const next = withBuiltinOverrides(base, { "repeated-word": { enabled: false } })
    expect(next.find((r) => r.id === "builtin:repeated-word")!.enabled).toBe(false)
    expect(next.find((r) => r.id === "builtin:double-space")!.enabled).toBe(true)
  })

  it("stamps punctuation conventions onto the two punctuation checks only", () => {
    const conventions = resolvePunctuation({ language: "th" }).conventions
    const next = withBuiltinOverrides(base, undefined, conventions)
    const check = (id: string) => next.find((r) => r.id === `builtin:${id}`)!.check
    expect(check("end-punctuation-mismatch")).toMatchObject({ punctuation: conventions })
    expect(check("punctuation-integrity")).toMatchObject({ punctuation: conventions })
    expect(check("double-space")).toEqual({ type: "builtin", checkId: "double-space" })
  })

  it("returns a non-built-in rule untouched, by identity", () => {
    const userRule = {
      id: "r1",
      name: "n",
      description: "",
      severity: "major" as const,
      source: "user" as const,
      scope: "project" as const,
      enabled: true,
      createdAt: "1970-01-01T00:00:00.000Z",
      check: { type: "target-forbids" as const, targetPattern: "x" },
    }
    expect(withBuiltinOverrides([userRule], { "double-space": { enabled: false } })[0]).toBe(userRule)
  })
})
