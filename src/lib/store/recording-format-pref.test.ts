import { beforeEach, describe, expect, it } from "vitest"

import {
  getRecordingFormatPref,
  resetRecordingFormatPrefCacheForTests,
  setRecordingFormatPref,
} from "./recording-format-pref"

const KEY = "aq.recording-format.v1"

describe("recording-format-pref", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetRecordingFormatPrefCacheForTests()
  })

  // The client's literal requirement: takes are WAV unless somebody opted out.
  it("defaults to wav when nothing is stored", () => {
    expect(getRecordingFormatPref()).toBe("wav")
  })

  it("persists only the opt-out to webm", () => {
    setRecordingFormatPref("webm")
    expect(getRecordingFormatPref()).toBe("webm")
    expect(localStorage.getItem(KEY)).toBe("webm")

    setRecordingFormatPref("wav")
    expect(getRecordingFormatPref()).toBe("wav")
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  // A half-written or hand-edited key must not produce a third format.
  it("treats an unrecognized stored value as wav", () => {
    localStorage.setItem(KEY, "mp3")
    resetRecordingFormatPrefCacheForTests()
    expect(getRecordingFormatPref()).toBe("wav")
  })
})
