import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

// The enabled flag is cached at module load, so each case re-imports.
async function load() {
  vi.resetModules()
  return import("./kill-switch")
}

/** AQU-1191: low-memory mode moves this switch's default, so the cases below
 *  arrange the device the same way the perf module reads it. */
function stubDeviceMemory(gb: number | undefined): void {
  if (gb === undefined) {
    delete (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    return
  }
  Object.defineProperty(navigator, "deviceMemory", {
    value: gb,
    configurable: true,
    writable: true,
  })
}

describe("health calculations switch", () => {
  beforeEach(() => {
    localStorage.clear()
    stubDeviceMemory(undefined)
  })

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

  describe("low-memory default (AQU-1191)", () => {
    it("starts off on a device low-memory mode calls constrained", async () => {
      stubDeviceMemory(2)
      const { isHealthCalculationsEnabled } = await load()
      expect(isHealthCalculationsEnabled()).toBe(false)
    })

    it("keeps an explicit on through a constrained device — the user's choice wins", async () => {
      stubDeviceMemory(2)
      localStorage.setItem("health-calculations", "1")
      const { isHealthCalculationsEnabled } = await load()
      expect(isHealthCalculationsEnabled()).toBe(true)
    })

    it("keeps an explicit off after low-memory mode is turned off", async () => {
      const mod = await load()
      mod.setHealthCalculationsEnabled(false)
      const { setLowMemoryMode } = await import("@/lib/perf/low-memory")
      setLowMemoryMode("off")
      expect(mod.isHealthCalculationsEnabled()).toBe(false)
    })

    it("moves the default live when the mode is switched, with no reload", async () => {
      const mod = await load()
      const { setLowMemoryMode } = await import("@/lib/perf/low-memory")
      const { result } = renderHook(() => mod.useHealthCalculationsEnabled())
      expect(result.current).toBe(true)
      act(() => setLowMemoryMode("on"))
      expect(result.current).toBe(false)
      act(() => setLowMemoryMode("auto"))
      expect(result.current).toBe(true)
    })
  })
})
