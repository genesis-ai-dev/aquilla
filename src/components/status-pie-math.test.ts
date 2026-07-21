import { describe, expect, it } from "vitest"
import { statusPieInnerStroke } from "@/components/status-pie-math"

const C = 2 * Math.PI * 2

describe("statusPieInnerStroke", () => {
  it("matches Linear half-pie offset", () => {
    const half = statusPieInnerStroke(0.515)
    expect(half.strokeDashoffset).toBeCloseTo(6.094689747964199, 2)
  })

  it("matches Linear ~19% pie offset", () => {
    const slice = statusPieInnerStroke(0.191)
    expect(slice.strokeDashoffset).toBeCloseTo(10.157816246606998, 1)
  })

  it("uses full circumference offset at 100%", () => {
    expect(statusPieInnerStroke(1).strokeDashoffset).toBeCloseTo(0, 5)
  })

  it("hides wedge at 0%", () => {
    expect(statusPieInnerStroke(0).strokeDashoffset).toBeCloseTo(C, 5)
  })
})

describe("validationProgressAfterClick", () => {
  it("steps 0% → 50% when requirement is 2", async () => {
    const { validationProgressAfterClick } = await import("@/components/status-pie-validation")
    expect(validationProgressAfterClick(0, 2)).toBe(0.5)
  })

  it("steps 50% → 100% when requirement is 2", async () => {
    const { validationProgressAfterClick } = await import("@/components/status-pie-validation")
    expect(validationProgressAfterClick(1, 2)).toBe(1)
  })
})

describe("isFullValidationStatus / validationPieTone", () => {
  it("treats quorum-met statuses as the done glyph", async () => {
    const { isFullValidationStatus } = await import("@/components/status-pie-validation")
    expect(isFullValidationStatus("full-self")).toBe(true)
    expect(isFullValidationStatus("full-others")).toBe(true)
    expect(isFullValidationStatus("full")).toBe(true)
    expect(isFullValidationStatus("others")).toBe(false)
  })

  it("colors only when you validated and quorum is still open", async () => {
    const { validationPieTone } = await import("@/components/status-pie-validation")
    expect(validationPieTone("self")).toBe("partial")
    expect(validationPieTone("others")).toBe("others")
    expect(validationPieTone("full-others")).toBe("others")
    expect(validationPieTone("none")).toBe("idle")
  })
})

describe("status pie palette", () => {
  it("exposes cyan for three-quarter progress", async () => {
    const { STATUS_PIE_CYAN, STATUS_PIE_PARTIAL, STATUS_PIE_COMPLETE_STROKE } =
      await import("@/components/status-pie-math")
    expect(STATUS_PIE_CYAN).toBe("#5DB1C9")
    expect(STATUS_PIE_PARTIAL).toBe("#F2C94C")
    expect(STATUS_PIE_COMPLETE_STROKE).toBe("var(--color-green-600)")
  })
})
