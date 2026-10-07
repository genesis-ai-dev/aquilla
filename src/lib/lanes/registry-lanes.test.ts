import { describe, expect, it } from "vitest"
import { canonicalLaneId, extraRegistryLanes, isPrimaryRegistryLane } from "./registry-lanes"

describe("extraRegistryLanes", () => {
  it("drops the primary when create stored it in the complete registry", () => {
    expect(extraRegistryLanes(["Spanish"], "Spanish")).toEqual([])
    expect(extraRegistryLanes(["Spanish", "French"], "Spanish")).toEqual(["French"])
  })

  it("treats a code and its English name as the same primary", () => {
    expect(isPrimaryRegistryLane("Spanish", "es")).toBe(true)
    expect(extraRegistryLanes(["Spanish", "French"], "es")).toEqual(["French"])
  })

  it("keeps a regional lane of the primary's language", () => {
    // languagesEqual("fr-CA", "French") is true — it ignores the region — but
    // Canadian French is its own lane in a French project.
    expect(isPrimaryRegistryLane("fr-CA", "French")).toBe(false)
    expect(extraRegistryLanes(["fr-CA", "fr-BE"], "French")).toEqual(["fr-CA", "fr-BE"])
    expect(extraRegistryLanes(["French", "fr-CA"], "fr")).toEqual(["fr-CA"])
  })

  it("drops a regional primary stored in the registry, whatever its case or separator", () => {
    expect(extraRegistryLanes(["fr-CA", "fr-BE"], "fr-CA")).toEqual(["fr-BE"])
    expect(extraRegistryLanes(["fr_ca", "fr-BE"], "fr-CA")).toEqual(["fr-BE"])
  })

  it("keeps extras-only registries used by older projects", () => {
    expect(extraRegistryLanes(["French"], "Spanish")).toEqual(["French"])
    expect(extraRegistryLanes(["swh"], null)).toEqual(["swh"])
  })

  it("drops blanks", () => {
    expect(extraRegistryLanes(["", "  ", "French"], "Spanish")).toEqual(["French"])
  })
})

describe("canonicalLaneId (AQU-1532)", () => {
  it("maps the primary language, in any spelling, to the default lane", () => {
    expect(canonicalLaneId("bla", "bla")).toBe("")
    expect(canonicalLaneId("BLA", "bla")).toBe("")
    expect(canonicalLaneId("es", "Spanish")).toBe("")
    expect(canonicalLaneId("fr_ca", "fr-CA")).toBe("")
  })

  it("keeps a non-primary or regional lane as named", () => {
    expect(canonicalLaneId("es", "bla")).toBe("es")
    expect(canonicalLaneId("fr-CA", "French")).toBe("fr-CA")
    expect(canonicalLaneId("bla-x", "bla")).toBe("bla-x")
    expect(canonicalLaneId("swh", null)).toBe("swh")
  })

  it("leaves an absent or default lane unchanged", () => {
    expect(canonicalLaneId(undefined, "bla")).toBeUndefined()
    expect(canonicalLaneId("", "bla")).toBe("")
  })
})
