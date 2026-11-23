import { describe, expect, it } from "vitest"
import { showsIntendedValue, type FieldReading } from "./observe"

const field = (value: string, attrs: Partial<FieldReading> = {}): FieldReading =>
  ({ value, label: "", placeholder: "", type: "text", role: "", ...attrs })

describe("input-value observation", () => {
  it("does not count the new name typed into project search as a rename attempt", () => {
    // PR #2092: this exact reading made a stuck agent a "product failure".
    const search = field("Adversarial b0af22 one", { label: "Search projects…", placeholder: "Search projects…" })
    expect(showsIntendedValue([search], ["Adversarial b0af22 one"])).toBe(false)
  })

  it("does not count a search box marked by its type or role", () => {
    expect(showsIntendedValue([field("New name", { type: "search" })], ["New name"])).toBe(false)
    expect(showsIntendedValue([field("New name", { role: "searchbox" })], ["New name"])).toBe(false)
  })

  it("still counts the rename field, so a rename the product drops stays a product failure", () => {
    const fields = [
      field("Adversarial b0af22 one", { label: "Search projects…" }),
      field(" Adversarial b0af22 one ", { label: "Project name" }),
    ]
    expect(showsIntendedValue(fields, ["Adversarial b0af22 one"])).toBe(true)
  })

  it("does not treat a label that merely mentions search as a search box", () => {
    expect(showsIntendedValue([field("Body", { label: "Research notes" })], ["Body"])).toBe(true)
  })
})
