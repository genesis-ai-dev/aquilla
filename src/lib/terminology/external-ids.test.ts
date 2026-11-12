// AQU-1693: a concept's Bible entity link. The link decides whose name a
// rendering becomes in Voices and Who's Who, so these pin that nothing
// malformed turns into a link, and that merging duplicates keeps the link.
import { describe, it, expect } from "vitest"
import { coerceExternalIds, sameExternalIds } from "./external-ids"
import { mergeConcepts } from "./store"
import type { Concept } from "./types"
import type { ProjectRecord } from "@/lib/parsers/types"

describe("coerceExternalIds", () => {
  it("keeps a well-formed ACAI id, from an object or its JSON text", () => {
    expect(coerceExternalIds({ acai: " person:Jesus.2 " })).toEqual({ acai: "person:Jesus.2" })
    expect(coerceExternalIds('{"acai":"place:Jerusalem"}')).toEqual({ acai: "place:Jerusalem" })
  })

  it("keeps `{}`: it is how an update says unlink", () => {
    expect(coerceExternalIds({})).toEqual({})
  })

  it("refuses what is not a links object or not an id, so it cannot become a link", () => {
    for (const bad of [null, 42, "not json", [], { acai: 42 }, { acai: "Jesus Christ" }, { acai: "Jesus" }, { acai: "" }]) {
      expect(coerceExternalIds(bad)).toBeUndefined()
    }
    expect(coerceExternalIds({ acai: `person:${"x".repeat(300)}` })).toBeUndefined()
  })

  it("drops keys it does not know", () => {
    expect(coerceExternalIds({ acai: "person:Peter", other: "x" })).toEqual({ acai: "person:Peter" })
  })

  it("compares links by value; no object and `{}` are both no link", () => {
    expect(sameExternalIds(undefined, {})).toBe(true)
    expect(sameExternalIds({ acai: "person:Peter" }, { acai: "person:Peter" })).toBe(true)
    expect(sameExternalIds({ acai: "person:Peter" }, undefined)).toBe(false)
  })
})

describe("mergeConcepts keeps the Bible entity link", () => {
  const concept = (id: string, acai?: string): Concept => ({
    id,
    sourceTerm: "Jesus",
    renderings: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(acai ? { externalIds: { acai } } : {}),
  })
  const merge = (terminology: Concept[], survivor: string) =>
    mergeConcepts({ terminology } as ProjectRecord, terminology.map((c) => c.id), survivor).terminology ?? []

  it("takes a merged-away concept's link when the survivor has none", () => {
    const [merged] = merge([concept("a"), concept("b", "person:Jesus.2")], "a")
    expect(merged.externalIds).toEqual({ acai: "person:Jesus.2" })
  })

  it("keeps the survivor's own link over another one", () => {
    const [merged] = merge([concept("a", "person:Joseph.4"), concept("b", "person:Joseph.10")], "a")
    expect(merged.externalIds).toEqual({ acai: "person:Joseph.4" })
  })
})
