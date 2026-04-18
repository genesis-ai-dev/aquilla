import { describe, it, expect } from "vitest"
import { BRANDS, BRAND_IDS } from "../brands"
import type { ThemeTokens } from "../types"

const TOKEN_KEYS: Array<keyof ThemeTokens> = [
  "background", "foreground", "card", "cardForeground", "popover", "popoverForeground",
  "primary", "primaryForeground", "secondary", "secondaryForeground",
  "muted", "mutedForeground", "accent", "accentForeground",
  "destructive", "border", "input", "ring",
  "chart1", "chart2", "chart3", "chart4", "chart5",
  "sidebar", "sidebarForeground", "sidebarPrimary", "sidebarPrimaryForeground",
  "sidebarAccent", "sidebarAccentForeground", "sidebarBorder", "sidebarRing",
]

describe("brand registry", () => {
  it("exposes exactly the three expected brands", () => {
    expect(BRAND_IDS.sort()).toEqual(["codex", "context", "honeycomb"])
  })

  for (const id of ["codex", "honeycomb", "context"] as const) {
    it(`${id} has complete copy, logo, and theme tokens`, () => {
      const b = BRANDS[id]
      expect(b.id).toBe(id)
      expect(b.app.name).toBeTruthy()
      expect(b.app.tagline).toBeTruthy()
      expect(b.app.htmlTitle).toBeTruthy()
      expect(b.marketing.onboardingHeadline).toBeTruthy()
      expect(b.marketing.onboardingSubhead).toBeTruthy()
      expect(b.logo.faviconHref).toBeTruthy()
      for (const k of TOKEN_KEYS) {
        expect(b.theme.light[k]).toBeTruthy()
        expect(b.theme.dark[k]).toBeTruthy()
      }
    })
  }
})
