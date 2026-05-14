import { describe, it, expect } from "vitest"
import { runCheck, extractPlaceholders } from "./placeholder-integrity"

describe("extractPlaceholders", () => {
  it("extracts curly placeholders", () => {
    expect(extractPlaceholders("Hello {name}, you have {count} messages"))
      .toEqual(["{name}", "{count}"])
  })
  it("extracts angle tags", () => {
    expect(extractPlaceholders("Click <a>here</a> to <b>continue</b>"))
      .toEqual(["<a>", "</a>", "<b>", "</b>"])
  })
  it("extracts printf-style", () => {
    expect(extractPlaceholders("%s found %d items, %1$s vs %2$s"))
      .toEqual(["%s", "%d", "%1$s", "%2$s"])
  })
  it("extracts escape sequences", () => {
    expect(extractPlaceholders("Line1\\nLine2\\tTabbed")).toEqual(["\\n", "\\t"])
  })
  it("extracts HTML entities", () => {
    expect(extractPlaceholders("Tom &amp; Jerry &nbsp;here")).toEqual(["&amp;", "&nbsp;"])
  })
})

describe("placeholder-integrity", () => {
  it("returns null when target contains all source placeholders", () => {
    expect(runCheck("Hello {name}", "Bonjour {name}")).toBeNull()
  })

  it("flags missing placeholder", () => {
    const spans = runCheck("Hello {name}, age {age}", "Bonjour {name}")
    expect(spans).not.toBeNull()
    expect(spans!.length).toBe(1)
    expect(spans![0].side).toBe("source")
    expect(spans![0].matchedText).toBe("{age}")
  })

  it("flags missing tag", () => {
    expect(runCheck("Click <a>here</a>", "Cliquez ici")).not.toBeNull()
  })

  it("returns null when source has no placeholders", () => {
    expect(runCheck("Plain text", "Texte simple")).toBeNull()
  })

  it("does not flag duplicates as missing", () => {
    expect(runCheck("{x} {x}", "{x} {x}")).toBeNull()
    expect(runCheck("{x} {x}", "{x}")).toBeNull() // count mismatch tolerated in v1
  })
})
