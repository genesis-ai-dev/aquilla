import { describe, expect, it } from "vitest"
import {
  MAX_REFERENCE_BIBLE_VERSIONS,
  REFERENCE_BIBLE_VERSIONS,
  isKnownReferenceBibleVersion,
  referenceBibleObjectKey,
  referenceBibleVersion,
  resolveReferenceBibleVersions,
  validateReferenceBibleVersions,
} from "./reference-bibles"
import { validateSettingsKeyValue } from "./project-settings-keys"

describe("reference Bible registry (AQU-1573)", () => {
  it("carries the Arabic Van Dyck version the ticket's partner needs", () => {
    const version = referenceBibleVersion("arb-vandyck")
    expect(version?.languageCode).toBe("arb")
    expect(version?.languageLabel).toBe("Arabic")
  })

  it("gives every version a unique id and an R2 prefix", () => {
    const ids = REFERENCE_BIBLE_VERSIONS.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const version of REFERENCE_BIBLE_VERSIONS) {
      expect(version.r2Prefix.endsWith("/")).toBe(true)
      expect(version.licence.trim()).not.toBe("")
    }
  })

  it("spells an object key as <prefix><BOOK>.usfm, upper-casing the book", () => {
    const version = referenceBibleVersion("arb-vandyck")!
    expect(referenceBibleObjectKey(version, "isa")).toBe("reference-bibles/arb-vandyck/ISA.usfm")
  })

  it("resolves ids in the caller's order, dropping unknown and duplicate ids", () => {
    const resolved = resolveReferenceBibleVersions(["eng-kjv", "nope", "eng-kjv", "arb-vandyck"])
    expect(resolved.map((v) => v.id)).toEqual(["eng-kjv", "arb-vandyck"])
  })

  it("treats an absent value as no reference Bible", () => {
    expect(resolveReferenceBibleVersions(undefined)).toEqual([])
    expect(isKnownReferenceBibleVersion("")).toBe(false)
  })
})

describe("validateReferenceBibleVersions", () => {
  it("accepts a known version", () => {
    expect(validateReferenceBibleVersions(["arb-vandyck"])).toBeNull()
    expect(validateReferenceBibleVersions([])).toBeNull()
  })

  it("names the unknown version AND the known ones, so a caller can correct itself", () => {
    const message = validateReferenceBibleVersions(["arb-vandyk"])
    expect(message).toContain('"arb-vandyk"')
    expect(message).toContain('"arb-vandyck"')
  })

  it("rejects a value that is not string[]", () => {
    expect(validateReferenceBibleVersions("arb-vandyck")).toContain("expects string[]")
    expect(validateReferenceBibleVersions([1])).toContain("expects string[]")
  })

  it("caps how many versions one project may name", () => {
    const tooMany = REFERENCE_BIBLE_VERSIONS.slice(0, MAX_REFERENCE_BIBLE_VERSIONS + 1).map((v) => v.id)
    expect(validateReferenceBibleVersions(tooMany)).toContain("at most")
  })
})

// REGRESSION GUARD: the ticket's first acceptance criterion is that
// PatchSettings accepts the key. It reaches it through the settings registry,
// so the registry — not just the validator above — has to know it.
describe("PatchSettings acceptance of referenceBibleVersions", () => {
  it("accepts a known version id", () => {
    expect(validateSettingsKeyValue("referenceBibleVersions", ["arb-vandyck"])).toBeNull()
  })

  it("accepts null, the only way to clear a settings key", () => {
    expect(validateSettingsKeyValue("referenceBibleVersions", null)).toBeNull()
  })

  it("rejects an unknown version id rather than storing a Bible nothing can supply", () => {
    expect(validateSettingsKeyValue("referenceBibleVersions", ["van-dyck"])).toContain(
      "unknown reference Bible version",
    )
  })

  it("rejects the wrong type with the registry's own type message", () => {
    expect(validateSettingsKeyValue("referenceBibleVersions", true)).toContain("expects string[]")
  })
})

// REGRESSION GUARD: an agent discovers the legal version ids from
// describe_command("PatchSettings"), not by probing. The doc line is rendered
// from the registry, so the two cannot drift.
describe("describe_command discoverability", () => {
  it("names every registry id in the PatchSettings key doc", async () => {
    const { settingsKeyDocLines } = await import("./project-settings-keys")
    const line = settingsKeyDocLines().find((l) => l.startsWith("referenceBibleVersions:"))
    expect(line).toBeDefined()
    for (const version of REFERENCE_BIBLE_VERSIONS) {
      expect(line).toContain(`"${version.id}"`)
    }
  })
})
