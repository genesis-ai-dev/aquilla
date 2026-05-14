import { describe, it, expect } from "vitest"
import { themeTokensToCssDeclarations, buildBrandThemeStyle } from "../theme-vars"
import type { ThemeTokens } from "../types"

const sample: ThemeTokens = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.145 0 0)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.145 0 0)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.145 0 0)",
  primary: "oklch(0.205 0 0)",
  primaryForeground: "oklch(0.985 0 0)",
  secondary: "oklch(0.97 0 0)",
  secondaryForeground: "oklch(0.205 0 0)",
  muted: "oklch(0.97 0 0)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "oklch(0.97 0 0)",
  accentForeground: "oklch(0.205 0 0)",
  destructive: "oklch(0.577 0.245 27.325)",
  border: "oklch(0.922 0 0)",
  input: "oklch(0.922 0 0)",
  ring: "oklch(0.708 0 0)",
  chart1: "oklch(0.87 0 0)",
  chart2: "oklch(0.556 0 0)",
  chart3: "oklch(0.439 0 0)",
  chart4: "oklch(0.371 0 0)",
  chart5: "oklch(0.269 0 0)",
  sidebar: "oklch(0.985 0 0)",
  sidebarForeground: "oklch(0.145 0 0)",
  sidebarPrimary: "oklch(0.205 0 0)",
  sidebarPrimaryForeground: "oklch(0.985 0 0)",
  sidebarAccent: "oklch(0.97 0 0)",
  sidebarAccentForeground: "oklch(0.205 0 0)",
  sidebarBorder: "oklch(0.922 0 0)",
  sidebarRing: "oklch(0.708 0 0)",
}

describe("themeTokensToCssDeclarations", () => {
  it("maps each token to a CSS custom property", () => {
    const out = themeTokensToCssDeclarations(sample)
    expect(out).toContain("--background: oklch(1 0 0);")
    expect(out).toContain("--primary: oklch(0.205 0 0);")
    expect(out).toContain("--primary-foreground: oklch(0.985 0 0);")
    expect(out).toContain("--muted-foreground: oklch(0.556 0 0);")
    expect(out).toContain("--chart-1: oklch(0.87 0 0);")
    expect(out).toContain("--sidebar-primary-foreground: oklch(0.985 0 0);")
  })
})

describe("buildBrandThemeStyle", () => {
  it("wraps light tokens in :root and dark tokens in html.dark", () => {
    const css = buildBrandThemeStyle({ light: sample, dark: sample })
    expect(css).toMatch(/:root\s*\{[^}]*--primary:/)
    expect(css).toMatch(/html\.dark\s*\{[^}]*--primary:/)
  })
})
