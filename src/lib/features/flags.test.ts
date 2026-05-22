import { describe, it, expect } from "vitest"
import { FLAGS, flagDefault, listFlags } from "./flags"

describe("FLAGS registry", () => {
  it("registers living-memory-view flag", () => {
    expect(FLAGS).toHaveProperty("living-memory-view")
    expect(FLAGS["living-memory-view"].default).toBe(false)
  })

  it("every flag has a non-empty label and description", () => {
    for (const [key, def] of Object.entries(FLAGS)) {
      expect(def.label, `flag "${key}" label`).toBeTruthy()
      expect(def.description, `flag "${key}" description`).toBeTruthy()
    }
  })
})

describe("flagDefault", () => {
  it("returns the registered default for a known flag", () => {
    expect(flagDefault("living-memory-view")).toBe(false)
  })
})

describe("listFlags", () => {
  it("returns every registered flag", () => {
    const entries = listFlags()
    expect(entries.length).toBe(Object.keys(FLAGS).length)
    const keys = entries.map((e) => e.key as string)
    expect(keys).toContain("living-memory-view")
  })

  it("each entry includes key and def", () => {
    for (const entry of listFlags()) {
      expect(entry).toHaveProperty("key")
      expect(entry).toHaveProperty("def")
      expect(entry.def.label).toBeTruthy()
    }
  })
})

