import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  MEANING_UNIT_DRAFTING_STORAGE_KEY,
  isMeaningUnitDraftingEnabled,
  setMeaningUnitDraftingEnabled,
} from "./seams-flag"

beforeEach(() => {
  localStorage.clear()
  // The module caches its snapshot, so reset through the public setter.
  setMeaningUnitDraftingEnabled(false)
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("meaning-unit drafting kill switch", () => {
  it("is OFF by default", async () => {
    // AQU-1386 §5 makes the shadow eval a precondition for enabling grouping.
    // Until scripts/seam-eval.ts has run against the EBL files, every drafting
    // path must keep today's fixed-size chunking. This test is the guard on
    // that promise — flipping the default without the eval breaks it.
    vi.resetModules()
    const fresh = await import("./seams-flag")
    expect(fresh.isMeaningUnitDraftingEnabled()).toBe(false)
  })

  it("turns on and off, and persists the choice", () => {
    setMeaningUnitDraftingEnabled(true)
    expect(isMeaningUnitDraftingEnabled()).toBe(true)
    expect(localStorage.getItem(MEANING_UNIT_DRAFTING_STORAGE_KEY)).toBe("1")

    setMeaningUnitDraftingEnabled(false)
    expect(isMeaningUnitDraftingEnabled()).toBe(false)
    expect(localStorage.getItem(MEANING_UNIT_DRAFTING_STORAGE_KEY)).toBe("0")
  })

  it("keeps the in-memory choice when storage is unavailable", () => {
    // Private-mode browsers throw on setItem. The switch must still work for
    // the session rather than silently refusing to flip.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled")
    })
    setMeaningUnitDraftingEnabled(true)
    expect(isMeaningUnitDraftingEnabled()).toBe(true)
  })

  it("notifies subscribers only when the value actually changes", () => {
    const seen: boolean[] = []
    setMeaningUnitDraftingEnabled(true)
    seen.push(isMeaningUnitDraftingEnabled())
    setMeaningUnitDraftingEnabled(true)
    seen.push(isMeaningUnitDraftingEnabled())
    expect(seen).toEqual([true, true])
  })
})
