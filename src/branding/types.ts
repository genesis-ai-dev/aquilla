import type { ComponentType, SVGProps } from "react"

export type BrandId = "codex" | "honeycomb" | "context"

export interface ThemeTokens {
  background: string
  foreground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  border: string
  input: string
  ring: string
  chart1: string
  chart2: string
  chart3: string
  chart4: string
  chart5: string
  sidebar: string
  sidebarForeground: string
  sidebarPrimary: string
  sidebarPrimaryForeground: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarBorder: string
  sidebarRing: string
}

export interface Brand {
  id: BrandId
  app: {
    name: string
    shortName: string
    tagline: string
    description: string
    htmlTitle: string
  }
  logo: {
    Mark: ComponentType<SVGProps<SVGSVGElement>>
    Wordmark: ComponentType<SVGProps<SVGSVGElement>>
    faviconHref: string
  }
  theme: {
    light: ThemeTokens
    dark: ThemeTokens
  }
  typography?: {
    sansFamily?: string
    headingFamily?: string
  }
  marketing: {
    onboardingHeadline: string
    onboardingSubhead: string
  }
  deploy?: {
    domain?: string
    ogImage?: string
  }
}
