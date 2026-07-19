import { describe, it, expect, beforeEach } from "vitest"
import { LOCALE_STORAGE_KEY, readStoredLocale, writeStoredLocale } from "./store"

describe("locale persistence", () => {
  beforeEach(() => window.localStorage.clear())

  it("returns null when nothing is stored", () => {
    expect(readStoredLocale()).toBeNull()
  })
  it("round-trips a written locale", () => {
    writeStoredLocale("my")
    expect(readStoredLocale()).toBe("my")
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("my")
  })
})
