import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

describe("current-brand resolver", () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    window.history.replaceState({}, "", "/")
  })

  it("returns aquilla when VITE_BRAND is not set", async () => {
    vi.stubEnv("VITE_BRAND", "")
    vi.stubEnv("DEV", false)
    const { brandId } = await import("../current-brand")
    expect(brandId).toBe("aquilla")
  })

  it("returns the brand from VITE_BRAND when valid", async () => {
    vi.stubEnv("VITE_BRAND", "honeycomb")
    vi.stubEnv("DEV", false)
    const { brandId } = await import("../current-brand")
    expect(brandId).toBe("honeycomb")
  })

  it("falls back to aquilla on unknown VITE_BRAND", async () => {
    vi.stubEnv("VITE_BRAND", "nonsense")
    vi.stubEnv("DEV", false)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { brandId } = await import("../current-brand")
    expect(brandId).toBe("aquilla")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("honors ?brand= override in dev mode", async () => {
    vi.stubEnv("VITE_BRAND", "aquilla")
    vi.stubEnv("DEV", true)
    window.history.replaceState({}, "", "/?brand=context")
    const { brandId } = await import("../current-brand")
    expect(brandId).toBe("context")
  })

  it("ignores ?brand= override when not in dev mode", async () => {
    vi.stubEnv("VITE_BRAND", "aquilla")
    vi.stubEnv("DEV", false)
    window.history.replaceState({}, "", "/?brand=context")
    const { brandId } = await import("../current-brand")
    expect(brandId).toBe("aquilla")
  })

  it("ignores unknown ?brand= override", async () => {
    vi.stubEnv("VITE_BRAND", "aquilla")
    vi.stubEnv("DEV", true)
    window.history.replaceState({}, "", "/?brand=nonsense")
    const { brandId } = await import("../current-brand")
    expect(brandId).toBe("aquilla")
  })
})
