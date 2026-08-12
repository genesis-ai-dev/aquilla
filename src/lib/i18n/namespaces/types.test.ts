import { describe, expect, it } from "vitest"
import { defineNamespace } from "./types"

describe("defineNamespace", () => {
  it("returns the module unchanged so barrels can spread it", () => {
    const mod = defineNamespace({
      keys: { "demo.save": "Save" },
      context: { _context: { description: "A demo surface used only in tests." } },
      surfaces: [],
    })
    expect(mod.keys["demo.save"]).toBe("Save")
    expect(mod.context._context.description).toContain("demo surface")
    expect(mod.surfaces).toEqual([])
  })
})
