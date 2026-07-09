import { describe, expect, it } from "vitest"
import {
  detectStrongTextDirection,
  languageDefaultDirection,
  resolveTextDirection,
  stripDirectionMarkup,
} from "./text-direction"

describe("text-direction", () => {
  it("detects RTL languages from codes and names", () => {
    expect(languageDefaultDirection("ar")).toBe("rtl")
    expect(languageDefaultDirection("arb")).toBe("rtl")
    expect(languageDefaultDirection("Arabic")).toBe("rtl")
    expect(languageDefaultDirection("heb")).toBe("rtl")
    expect(languageDefaultDirection("Persian")).toBe("rtl")
    expect(languageDefaultDirection("English")).toBe("ltr")
  })

  it("detects first strong direction from text", () => {
    expect(detectStrongTextDirection("שלום world")).toBe("rtl")
    expect(detectStrongTextDirection("Hello שלום")).toBe("ltr")
    expect(detectStrongTextDirection("123 ?!")).toBeNull()
  })

  it("strips simple markup and footnotes before detection", () => {
    expect(stripDirectionMarkup("<p>&quot;Hello&quot;</p> \\f + \\ft note\\f*")).toBe('"Hello"')
    expect(detectStrongTextDirection("<span data-usfm-footnote='x'>1</span> العربية")).toBe("rtl")
  })

  it("resolves auto mode from content with fallback", () => {
    expect(resolveTextDirection("auto", "random?", "rtl")).toBe("ltr")
    expect(resolveTextDirection("auto", "123", "rtl")).toBe("rtl")
    expect(resolveTextDirection("ltr", "العربية", "rtl")).toBe("ltr")
  })
})
