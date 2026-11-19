import { describe, it, expect } from "vitest"
import { healthRibbonPointsEqual, memoizedRowPropsEqual } from "./editor-row-memo"
import type { HealthRibbonPoint } from "@/lib/health/health-ribbon"

const point = (overrides: Partial<HealthRibbonPoint> = {}): HealthRibbonPoint => ({
  id: "cell-1",
  stage: "automatic",
  rawScore: 80,
  smoothedScore: 78,
  topScore: 77,
  bottomScore: 79,
  topOpacity: 0.5,
  bottomOpacity: 0.6,
  evidenceWeight: 1,
  ...overrides,
})

describe("memoizedRowPropsEqual (AQU-2654)", () => {
  const onClick = () => {}
  const cell = { id: "cell-1" }
  const base = { cell, onClick, isEditorActive: false, repetitionCount: undefined as number | undefined, healthRibbonPoint: point() }

  it("holds when nothing changed", () => {
    expect(memoizedRowPropsEqual(base, { ...base })).toBe(true)
  })

  it("holds when the ribbon point is a new object with the same numbers", () => {
    expect(memoizedRowPropsEqual(base, { ...base, healthRibbonPoint: point() })).toBe(true)
  })

  it("lets a ribbon point through when any of its numbers moved", () => {
    expect(memoizedRowPropsEqual(base, { ...base, healthRibbonPoint: point({ smoothedScore: 79 }) })).toBe(false)
    expect(memoizedRowPropsEqual(base, { ...base, healthRibbonPoint: point({ stage: "validated" }) })).toBe(false)
    expect(memoizedRowPropsEqual(base, { ...base, healthRibbonPoint: point({ topOpacity: undefined }) })).toBe(false)
  })

  it("is an ordinary shallow compare for every other prop", () => {
    expect(memoizedRowPropsEqual(base, { ...base, isEditorActive: true })).toBe(false)
    expect(memoizedRowPropsEqual(base, { ...base, repetitionCount: 3 })).toBe(false)
    expect(memoizedRowPropsEqual(base, { ...base, onClick: () => {} })).toBe(false)
    // Equal content is not enough anywhere else: a rebuilt cell IS a change.
    expect(memoizedRowPropsEqual(base, { ...base, cell: { id: "cell-1" } })).toBe(false)
  })

  it("sees a prop that was added or removed", () => {
    const withExtra = { ...base, extra: 1 }
    expect(memoizedRowPropsEqual(base, withExtra as typeof base)).toBe(false)
    expect(memoizedRowPropsEqual(withExtra as typeof base, base)).toBe(false)
  })

  it("healthRibbonPointsEqual compares every field", () => {
    expect(healthRibbonPointsEqual(point(), point())).toBe(true)
    for (const change of [
      { id: "cell-2" }, { rawScore: 1 }, { topScore: 1 }, { bottomScore: 1 }, { bottomOpacity: 1 }, { evidenceWeight: 0.5 },
    ] satisfies Array<Partial<HealthRibbonPoint>>) {
      expect(healthRibbonPointsEqual(point(), point(change))).toBe(false)
    }
  })
})
