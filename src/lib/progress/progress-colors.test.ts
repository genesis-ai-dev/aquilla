import { describe, it, expect } from "vitest"
import { getCompletedValidationLevels, getProgressColor, getProgressDisplay } from "./progress-colors"

describe("getCompletedValidationLevels", () => {
  it("returns 0 when levels missing", () => {
    expect(getCompletedValidationLevels(undefined, 3)).toBe(0)
    expect(getCompletedValidationLevels([], 3)).toBe(0)
  })
  it("returns 0 when required is missing", () => {
    expect(getCompletedValidationLevels([100, 100], undefined)).toBe(0)
  })
  it("counts consecutive 100% levels up to required", () => {
    expect(getCompletedValidationLevels([100, 100, 50, 0], 4)).toBe(2)
  })
  it("stops at first incomplete level", () => {
    expect(getCompletedValidationLevels([100, 80, 100], 3)).toBe(1)
  })
})

describe("getProgressColor", () => {
  it("no content → faint muted", () => {
    expect(getProgressColor(0, 0)).toBe("text-muted-foreground/25")
  })
  it("partial translation → muted 80%", () => {
    expect(getProgressColor(0, 50)).toBe("text-muted-foreground/80")
  })
  it("fully translated, no validation → blue", () => {
    expect(getProgressColor(0, 100)).toBe("text-charts-blue")
  })
  it("fully translated, ≥1 validator level → dark blue", () => {
    expect(getProgressColor(50, 100, [100, 50], 2)).toBe("text-charts-blue-dark")
  })
  it("fully validated → warning", () => {
    expect(getProgressColor(100, 100)).toBe("text-editor-warning-foreground")
  })
})

describe("getProgressDisplay", () => {
  it("returns colorClass, title, completedValidationLevels", () => {
    const d = getProgressDisplay(50, 100, "Text", [100, 50], 2)
    expect(d.colorClass).toBe("text-charts-blue-dark")
    expect(d.completedValidationLevels).toBe(1)
    expect(d.title).toContain("Translation: 100%")
    expect(d.title).toContain("Validation: 50%")
    expect(d.title).toContain("1 level")
  })
})
