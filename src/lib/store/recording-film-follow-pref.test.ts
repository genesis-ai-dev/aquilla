import { beforeEach, describe, expect, it } from "vitest"

import {
  getRecordingFilmFollow,
  resetRecordingFilmFollowCacheForTests,
  setRecordingFilmFollow,
} from "./recording-film-follow-pref"

const KEY = "aq.recording-film-follow.v1"

describe("recording-film-follow-pref", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetRecordingFilmFollowCacheForTests()
  })

  it("defaults to on when nothing is stored", () => {
    expect(getRecordingFilmFollow()).toBe(true)
  })

  it("persists only the opt-out", () => {
    setRecordingFilmFollow(false)
    expect(getRecordingFilmFollow()).toBe(false)
    expect(localStorage.getItem(KEY)).toBe("off")

    setRecordingFilmFollow(true)
    expect(getRecordingFilmFollow()).toBe(true)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("reads a stored opt-out after a cache reset (fresh session)", () => {
    localStorage.setItem(KEY, "off")
    resetRecordingFilmFollowCacheForTests()
    expect(getRecordingFilmFollow()).toBe(false)
  })
})
