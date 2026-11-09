/**
 * The prep step before the first Paratext scan exists so an OS file-access
 * prompt is not a surprise. What matters: a fresh device gets the prep step
 * (absent key = not ready), a completed scan is remembered across reloads so
 * the step is not shown twice, and anything else stored reads as not ready.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  getParatextScanReady,
  resetParatextScanPrefForTests,
  setParatextScanReady,
} from "./paratext-scan-pref"

const STORAGE_KEY = "aq.paratext-scan.v1"

beforeEach(() => {
  localStorage.clear()
  resetParatextScanPrefForTests()
})

describe("paratext scan readiness", () => {
  it("is not ready on a fresh device, so the prep step shows first", () => {
    expect(getParatextScanReady()).toBe(false)
  })

  it("remembers a completed scan across a reload", () => {
    setParatextScanReady(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("ok")
    resetParatextScanPrefForTests()
    expect(getParatextScanReady()).toBe(true)
  })

  it("clears back to not-ready by removing the key", () => {
    setParatextScanReady(true)
    setParatextScanReady(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(getParatextScanReady()).toBe(false)
  })

  it("treats any other stored value as not ready", () => {
    localStorage.setItem(STORAGE_KEY, "true")
    resetParatextScanPrefForTests()
    expect(getParatextScanReady()).toBe(false)
  })
})
