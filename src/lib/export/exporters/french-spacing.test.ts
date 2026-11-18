import { describe, it, expect } from "vitest"
import { frenchSpacing, isFrenchLanguage } from "./french-spacing"

const NB = " "

describe("frenchSpacing (AQU-2539)", () => {
  it("swaps the ordinary space before ; : ! ? » and after « for a no-break space", () => {
    expect(frenchSpacing("Figure 1 : la légende ; vraiment ! Pourquoi ? « Oui » dit-il."))
      .toBe(`Figure 1${NB}: la légende${NB}; vraiment${NB}! Pourquoi${NB}? «${NB}Oui${NB}» dit-il.`)
  })

  it("adds no space where there is none", () => {
    expect(frenchSpacing("Note: «Oui»!")).toBe("Note: «Oui»!")
  })

  it("touches nothing else: other spaces, tabs, other punctuation", () => {
    expect(frenchSpacing("a b\t: c , d . e")).toBe("a b\t: c , d . e")
  })

  it("keeps the text's length", () => {
    const text = "x : y « z » ?"
    expect(frenchSpacing(text)).toHaveLength(text.length)
  })
})

describe("isFrenchLanguage", () => {
  it("is true for fr and fr-*, and nothing else", () => {
    expect(["fr", "fr-FR", "FR-ca", "fr_BE"].map(isFrenchLanguage)).toEqual([true, true, true, true])
    expect(["fra", "frr", "en", "", null, undefined, "French"].map(isFrenchLanguage)).toEqual([false, false, false, false, false, false, false])
  })
})
