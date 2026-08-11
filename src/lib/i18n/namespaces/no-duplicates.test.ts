import { describe, expect, it } from "vitest"
import { NAMESPACES } from "./index"
import { common } from "./common"

const normalize = (s: string) => s.trim().toLowerCase().replace(/[…:]+$/, "")

describe("catalog has no duplicate English strings (AQU-511)", () => {
  it("does not re-key a string that common.* already provides", () => {
    const shared = new Map(
      Object.entries(common.keys).map(([key, value]) => [normalize(value), key]),
    )
    const offenders: string[] = []
    for (const ns of NAMESPACES) {
      if (ns === common) continue
      for (const [key, value] of Object.entries(ns.keys)) {
        const existing = shared.get(normalize(value))
        if (existing) offenders.push(`${key} duplicates ${existing} ("${value}")`)
      }
    }
    // Every duplicate is a string a human translator is asked to translate
    // twice, in four locales. Reuse the common.* key instead.
    expect(offenders).toEqual([])
  })

  it("has no two namespaces claiming the same key", () => {
    const seen = new Set<string>()
    const collisions: string[] = []
    for (const ns of NAMESPACES) {
      for (const key of Object.keys(ns.keys)) {
        if (seen.has(key)) collisions.push(key)
        seen.add(key)
      }
    }
    // A collision means one namespace's spread silently overwrites another's.
    expect(collisions).toEqual([])
  })
})
