import type { BrandData } from "../types.ts"
import { contextData } from "./context.data.ts"

// Generic example profile showing how a separate product can customize
// copy and colors without shipping that product's identity or artwork.
export const exampleContextData: BrandData = {
  ...contextData,
  id: "example-context",
  app: {
    name: "Example Context",
    shortName: "Example",
    tagline: "A sample custom brand.",
    description: "Example configuration for a custom-branded translation app.",
    htmlTitle: "Example Context",
  },
  logo: { faviconHref: "/favicon-aquilla.svg" },
  marketing: {
    onboardingHeadline: "Welcome to Example Context",
    onboardingSubhead: "A sample custom-branded translation workspace.",
  },
}
