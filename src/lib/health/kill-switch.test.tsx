import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

// The enabled flag is cached at module load, so each case re-imports.
async function load() {
  vi.resetModules()
  return import("./kill-switch")
}

describe("health calculations switch", () => {
  beforeEach(() => localStorage.clear())

  it("is on when the user has never chosen — health is a default-on feature", async () => {
    const { isHealthCalculationsEnabled } = await load()
    expect(isHealthCalculationsEnabled()).toBe(true)
  })

  it('stays off across reloads once the user turns it off ("0" persists)', async () => {
    const first = await load()
    first.setHealthCalculationsEnabled(false)
    expect(localStorage.getItem("health-calculations")).toBe("0")

    const afterReload = await load()
    expect(afterReload.isHealthCalculationsEnabled()).toBe(false)
  })

  it("turns back on from the same toggle", async () => {
    localStorage.setItem("health-calculations", "0")
    const mod = await load()
    expect(mod.isHealthCalculationsEnabled()).toBe(false)
    mod.setHealthCalculationsEnabled(true)
    expect(mod.isHealthCalculationsEnabled()).toBe(true)
  })

  it("re-renders consumers on toggle so the editor drops health work without a reload", async () => {
    const { useHealthCalculationsEnabled, setHealthCalculationsEnabled } = await load()
    const { result } = renderHook(() => useHealthCalculationsEnabled())
    expect(result.current).toBe(true)
    act(() => setHealthCalculationsEnabled(false))
    expect(result.current).toBe(false)
  })
})
