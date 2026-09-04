import { readFileSync } from "node:fs"
import { createElement } from "react"
import { render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  applyFontSizeScale,
  FONT_SIZE_ROOT_PX,
  FONT_SIZE_STORAGE_KEY,
  FontSizeProvider,
  isFontSizeScale,
  readStoredFontSizeScale,
} from "../FontSize"

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.style.removeProperty("font-size")
})

describe("font-size scale map", () => {
  it("uses Linear's live Preferences px values", () => {
    expect(FONT_SIZE_ROOT_PX.small).toBe(14)
    expect(FONT_SIZE_ROOT_PX.default).toBeNull()
    expect(FONT_SIZE_ROOT_PX.large).toBe(18)
    expect(FONT_SIZE_ROOT_PX["extra-large"]).toBe(20)
  })

  it("keeps the index.html boot script in lockstep with the runtime map", () => {
    // Bare relative path: vitest's fs shim resolves against the project root.
    // process.cwd() is "/" here, and import.meta.url is not a file: URL.
    const html = readFileSync("index.html", "utf8")
    expect(html).toContain(`localStorage.getItem("${FONT_SIZE_STORAGE_KEY}")`)
    expect(html).toContain('small: "14px"')
    expect(html).toContain('large: "18px"')
    expect(html).toContain('"extra-large": "20px"')
    expect(html).not.toMatch(/default:\s*"16px"/)
  })
})

describe("applyFontSizeScale", () => {
  it("sets the document root for Large and Extra Large", () => {
    applyFontSizeScale("large")
    expect(document.documentElement.style.fontSize).toBe("18px")
    applyFontSizeScale("extra-large")
    expect(document.documentElement.style.fontSize).toBe("20px")
  })

  it("sets Small to 14px", () => {
    applyFontSizeScale("small")
    expect(document.documentElement.style.fontSize).toBe("14px")
  })

  it("unsets the root at Default so today's sizes stay exact", () => {
    applyFontSizeScale("large")
    applyFontSizeScale("default")
    expect(document.documentElement.style.fontSize).toBe("")
  })
})

describe("readStoredFontSizeScale", () => {
  it("returns Default when nothing is stored", () => {
    expect(readStoredFontSizeScale()).toBe("default")
  })

  it("returns the stored scale and rejects unknown values", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "large")
    expect(readStoredFontSizeScale()).toBe("large")
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "huge")
    expect(readStoredFontSizeScale()).toBe("default")
    expect(isFontSizeScale("extra-large")).toBe(true)
    expect(isFontSizeScale("medium")).toBe(false)
  })
})

describe("FontSizeProvider", () => {
  it("applies a stored Extra Large scale on mount", async () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "extra-large")
    render(createElement(FontSizeProvider, null, "ok"))
    await waitFor(() => {
      expect(document.documentElement.style.fontSize).toBe("20px")
    })
  })
})
