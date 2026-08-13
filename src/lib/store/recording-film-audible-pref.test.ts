import { beforeEach, describe, expect, it } from "vitest"

import {
  getRecordingFilmAudible,
  resetRecordingFilmAudibleCacheForTests,
  setRecordingFilmAudible,
} from "./recording-film-audible-pref"

const KEY = "aq.recording-film-audible.v1"

describe("recording-film-audible-pref", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetRecordingFilmAudibleCacheForTests()
  })

  // Muted is the safe state — the mic records with echo cancellation off.
  it("defaults to muted when nothing is stored", () => {
    expect(getRecordingFilmAudible()).toBe(false)
  })

  it("persists only the opt-in to audible", () => {
    setRecordingFilmAudible(true)
    expect(getRecordingFilmAudible()).toBe(true)
    expect(localStorage.getItem(KEY)).toBe("on")

    setRecordingFilmAudible(false)
    expect(getRecordingFilmAudible()).toBe(false)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("reads a stored opt-in after a cache reset (fresh session)", () => {
    localStorage.setItem(KEY, "on")
    resetRecordingFilmAudibleCacheForTests()
    expect(getRecordingFilmAudible()).toBe(true)
  })
})
