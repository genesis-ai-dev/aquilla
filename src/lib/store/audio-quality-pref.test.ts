import { beforeEach, describe, expect, it } from "vitest"

import {
  getAudioQualityPref,
  resetAudioQualityPrefCacheForTests,
  setAudioQualityPref,
} from "./audio-quality-pref"

const KEY = "aq.audio-quality.v1"

describe("audio-quality-pref", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetAudioQualityPrefCacheForTests()
  })

  it("defaults to compressed when nothing is stored", () => {
    expect(getAudioQualityPref()).toBe("compressed")
  })

  it("persists only the opt-in to original", () => {
    setAudioQualityPref("original")
    expect(getAudioQualityPref()).toBe("original")
    expect(localStorage.getItem(KEY)).toBe("original")

    setAudioQualityPref("compressed")
    expect(getAudioQualityPref()).toBe("compressed")
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("reads a stored opt-in after a cache reset (fresh session)", () => {
    localStorage.setItem(KEY, "original")
    resetAudioQualityPrefCacheForTests()
    expect(getAudioQualityPref()).toBe("original")
  })

  it("treats an unrecognized stored value as the default", () => {
    localStorage.setItem(KEY, "extreme")
    resetAudioQualityPrefCacheForTests()
    expect(getAudioQualityPref()).toBe("compressed")
  })
})
