import { describe, it, expect, beforeEach } from "vitest"
import { applyTheme } from "../apply-theme"
import { codex } from "../brands/codex"
import { honeycomb } from "../brands/honeycomb"

describe("applyTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-brand")
    document.getElementById("brand-theme")?.remove()
    document.getElementById("brand-theme-dynamic")?.remove()
  })

  it("sets data-brand on <html>", () => {
    applyTheme(codex)
    expect(document.documentElement.getAttribute("data-brand")).toBe("codex")
  })

  it("injects a <style id='brand-theme-dynamic'> with :root and html.dark blocks", () => {
    applyTheme(honeycomb)
    const el = document.getElementById("brand-theme-dynamic")
    expect(el).not.toBeNull()
    const css = el!.textContent ?? ""
    expect(css).toMatch(/:root\s*\{[^}]*--primary:\s*oklch\(0\.72/)
    expect(css).toMatch(/html\.dark\s*\{[^}]*--primary:\s*oklch\(0\.78/)
  })

  it("replaces the dynamic style tag when applied twice", () => {
    applyTheme(codex)
    applyTheme(honeycomb)
    const all = document.querySelectorAll("style#brand-theme-dynamic")
    expect(all.length).toBe(1)
    expect(all[0].textContent).toContain("oklch(0.72 0.17 75)")
  })

  it("applies optional typography overrides", () => {
    applyTheme({ ...codex, typography: { sansFamily: "MyFont, sans-serif" } })
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe("MyFont, sans-serif")
  })
})
