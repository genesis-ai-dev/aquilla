import type { BrandData } from "../types.ts"
import { honeycombData } from "./honeycomb.data.ts"

// Generic example profile showing how a separate product can customize
// copy and colors without shipping that product's identity or artwork.
export const exampleHoneycombData: BrandData = {
  ...honeycombData,
  id: "example-honeycomb",
  app: {
    name: "Example Honeycomb",
    shortName: "Example",
    tagline: "A sample custom brand.",
    description: "Example configuration for a custom-branded translation app.",
    htmlTitle: "Example Honeycomb",
  },
  logo: { faviconHref: "/favicon-aquilla.svg" },
  marketing: {
    onboardingHeadline: "Welcome to Example Honeycomb",
    onboardingSubhead: "A sample custom-branded translation workspace.",
  },
}
