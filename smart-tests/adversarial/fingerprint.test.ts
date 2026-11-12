import { describe, expect, it } from "vitest"
import { fingerprint, marker } from "./fingerprint"

describe("failure fingerprint", () => {
  it("dedups the same failure regardless of check order, so one bug keeps one ticket", () => {
    expect(fingerprint("edit.reload-mid-type", "edit", ["b", "a"], []))
      .toBe(fingerprint("edit.reload-mid-type", "edit", ["a", "b"], []))
  })

  it("separates different attacks and different broken checks, so distinct bugs are not merged", () => {
    const base = fingerprint("edit.reload-mid-type", "edit", ["requirementsMet"], ["target-value"])
    expect(fingerprint("edit.back-button", "edit", ["requirementsMet"], ["target-value"])).not.toBe(base)
    expect(fingerprint("edit.reload-mid-type", "edit", ["invariantsHeld"], [])).not.toBe(base)
  })

  it("renders a searchable marker", () => {
    expect(marker("abc123def456")).toBe("adv-fp:abc123def456")
  })
})
