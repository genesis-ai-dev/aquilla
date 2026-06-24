import type { ComponentType, HTMLAttributes } from "react"

export type BrandLogoProps = HTMLAttributes<HTMLElement> & { className?: string }

export type BrandId = "aquilla" | "codex" | "honeycomb" | "context"

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

export interface BrandData {
  id: BrandId
  app: {
    name: string
    shortName: string
    tagline: string
    description: string
    htmlTitle: string
  }
  logo: {
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
    ogImageWidth?: number
    ogImageHeight?: number
    ogImageAlt?: string
  }
}

export interface Brand extends Omit<BrandData, "logo"> {
  logo: BrandData["logo"] & {
    Mark: ComponentType<BrandLogoProps>
    Wordmark: ComponentType<BrandLogoProps>
  }
}
