import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  PASSAGE_TAGS_STORAGE_KEY,
  arePassageTagsEnabled,
  setPassageTagsEnabled,
} from "./passage-tags-flag"

beforeEach(() => {
  localStorage.clear()
  // The module caches its snapshot, so reset through the public setter.
  setPassageTagsEnabled(false)
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("passage-tag kill switch", () => {
  it("is OFF by default", async () => {
    // AQU-657 makes a shadow eval a precondition for each slice. Until
    // `pnpm tags:eval --live` has been run and its numbers posted, nothing spends
    // a Jev call on tagging — the lexical heuristic needs no network at all. This
    // test is the guard on that promise.
    vi.resetModules()
    const fresh = await import("./passage-tags-flag")
    expect(fresh.arePassageTagsEnabled()).toBe(false)
  })

  it("turns on and off, and persists the choice", () => {
    setPassageTagsEnabled(true)
    expect(arePassageTagsEnabled()).toBe(true)
    expect(localStorage.getItem(PASSAGE_TAGS_STORAGE_KEY)).toBe("1")

    setPassageTagsEnabled(false)
    expect(arePassageTagsEnabled()).toBe(false)
    expect(localStorage.getItem(PASSAGE_TAGS_STORAGE_KEY)).toBe("0")
  })

  it("keeps the in-memory choice when storage is unavailable", () => {
    // Private-mode browsers throw on setItem. The switch must still work for the
    // session rather than silently refusing to flip.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled")
    })
    setPassageTagsEnabled(true)
    expect(arePassageTagsEnabled()).toBe(true)
  })
})
