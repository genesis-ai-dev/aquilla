/**
 * AQU-2317: the role ladder's two load-bearing promises. If either breaks, the
 * pills stop being readable as a ladder — or stop being readable at all.
 */
import { describe, expect, it } from "vitest"

import { ALL_ROLE_LEVELS, ROLE } from "@/lib/frontier/roles"
import {
  ROLE_INK_LIGHTNESS,
  ROLE_RUNGS,
  lightnessContrast,
  roleRung,
  rungContrast,
} from "./role-scale"

describe("role lightness scale", () => {
  it("gives every canonical level exactly one rung, numbered 1…7", () => {
    expect(ROLE_RUNGS.map((r) => r.level)).toEqual([...ALL_ROLE_LEVELS])
    expect(ROLE_RUNGS.map((r) => r.step)).toEqual([1, 2, 3, 4, 5, 6, 7])
    for (const level of ALL_ROLE_LEVELS) expect(roleRung(level)?.level).toBe(level)
  })

  it("has no rung for 'no access' or an off-ladder level", () => {
    expect(roleRung(null)).toBeUndefined()
    expect(roleRung(undefined)).toBeUndefined()
    expect(roleRung(250)).toBeUndefined()
  })

  it("gets strictly darker as the role gets higher", () => {
    const fills = ROLE_RUNGS.map((r) => r.fillLightness)
    expect(fills).toEqual([...fills].sort((a, b) => b - a))
    expect(new Set(fills).size).toBe(fills.length)
    // The ladder reads as darkness, so the ends must be far apart, not merely ordered.
    expect(roleRung(ROLE.VIEWER)!.fillLightness - roleRung(ROLE.OWNER)!.fillLightness).toBeGreaterThan(0.5)
  })

  it("clears WCAG AA text contrast on every rung, in both themes", () => {
    // Every rung pairs its fill with one of two inks and the pair is painted
    // together (`role-rung-N` sets both). The fill lightness is absolute, so
    // these ratios are the same under .dark as under :root — nothing here
    // reads --background.
    for (const rung of ROLE_RUNGS) {
      expect(rungContrast(rung), `rung ${rung.step} (level ${rung.level})`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("measures contrast from Oklab lightness (L is the cube root of luminance)", () => {
    expect(lightnessContrast(1, 0)).toBeCloseTo(21, 1)
    expect(lightnessContrast(0.5, 0.5)).toBe(1)
    // Symmetric: order of arguments never changes the ratio.
    expect(lightnessContrast(0.32, ROLE_INK_LIGHTNESS.light)).toBe(
      lightnessContrast(ROLE_INK_LIGHTNESS.light, 0.32),
    )
  })
})
