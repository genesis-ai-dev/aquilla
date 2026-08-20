import type { ThemeTokens } from "./types.ts"

const TOKEN_TO_VAR: Record<keyof ThemeTokens, string> = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  border: "--border",
  input: "--input",
  ring: "--ring",
  chart1: "--chart-1",
  chart2: "--chart-2",
  chart3: "--chart-3",
  chart4: "--chart-4",
  chart5: "--chart-5",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarPrimary: "--sidebar-primary",
  sidebarPrimaryForeground: "--sidebar-primary-foreground",
  sidebarAccent: "--sidebar-accent",
  sidebarAccentForeground: "--sidebar-accent-foreground",
  sidebarBorder: "--sidebar-border",
  sidebarRing: "--sidebar-ring",
}

export function themeTokensToCssDeclarations(tokens: ThemeTokens): string {
  return (Object.keys(TOKEN_TO_VAR) as Array<keyof ThemeTokens>)
    .map((k) => `${TOKEN_TO_VAR[k]}: ${tokens[k]};`)
    .join(" ")
}

export function buildBrandThemeStyle(theme: { light: ThemeTokens; dark: ThemeTokens }): string {
  const light = themeTokensToCssDeclarations(theme.light)
  const dark = themeTokensToCssDeclarations(theme.dark)
  return `:root { ${light} } html.dark { ${dark} }`
}
