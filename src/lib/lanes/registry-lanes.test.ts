import { describe, expect, it } from "vitest"
import { extraRegistryLanes, isPrimaryRegistryLane } from "./registry-lanes"

describe("extraRegistryLanes", () => {
  it("drops the primary when create stored it in the complete registry", () => {
    expect(extraRegistryLanes(["Spanish"], "Spanish")).toEqual([])
    expect(extraRegistryLanes(["Spanish", "French"], "Spanish")).toEqual(["French"])
  })

  it("treats a code and its English name as the same primary", () => {
    expect(isPrimaryRegistryLane("Spanish", "es")).toBe(true)
    expect(extraRegistryLanes(["Spanish", "French"], "es")).toEqual(["French"])
  })

  it("keeps extras-only registries used by older projects", () => {
    expect(extraRegistryLanes(["French"], "Spanish")).toEqual(["French"])
    expect(extraRegistryLanes(["swh"], null)).toEqual(["swh"])
  })

  it("drops blanks", () => {
    expect(extraRegistryLanes(["", "  ", "French"], "Spanish")).toEqual(["French"])
  })
})
