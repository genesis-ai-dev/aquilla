import { describe, it, expect } from "vitest"
import type { ProjectRecord } from "@/lib/parsers/types"
import { getFlagValue } from "./flag-selector"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
    name: "Test",
    sourceLanguage: "en",
    targetLanguage: "sw",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

describe("getFlagValue", () => {
  it("returns registry default when project is null", () => {
    expect(getFlagValue(null, "living-memory-view")).toBe(false)
  })

  it("returns registry default when project has no experimentalFlags", () => {
    const p = makeProject()
    expect(getFlagValue(p, "living-memory-view")).toBe(false)
  })

  it("returns registry default when flag not set on project", () => {
    const p = makeProject({ experimentalFlags: {} })
    expect(getFlagValue(p, "living-memory-view")).toBe(false)
  })

  it("returns stored value when set to true", () => {
    const p = makeProject({ experimentalFlags: { "living-memory-view": true } })
    expect(getFlagValue(p, "living-memory-view")).toBe(true)
  })

  it("returns stored value when set to false explicitly", () => {
    const p = makeProject({ experimentalFlags: { "living-memory-view": false } })
    expect(getFlagValue(p, "living-memory-view")).toBe(false)
  })

  it("ignores non-boolean stored values and falls back to default", () => {
    // Simulate legacy/corrupt data: a non-boolean slipped into the record.
    const p = makeProject({
      experimentalFlags: { "living-memory-view": "true" as unknown as boolean },
    })
    expect(getFlagValue(p, "living-memory-view")).toBe(false)
  })
})
