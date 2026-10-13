// AQU-1687 — each person's Bible data view options.
//
// What this protects: the options default to showing Voices (the project
// decides whether Voices exists; a person only hides what it shows), and a
// stored value that is missing, unreadable or of the wrong type can never
// switch on something the person did not choose. It falls back to the
// default, one field at a time.

import { beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_BIBLE_DATA_VIEW_PREFS,
  getBibleDataViewPrefs,
  resetBibleDataViewPrefsCacheForTests,
  setBibleDataViewPrefs,
} from "./bible-data-view-prefs"

const KEY = "aq.bible-data-view.v1"

beforeEach(() => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
})

describe("Bible data view options", () => {
  it("shows chips and rails, with project names first, until the person changes them", () => {
    expect(getBibleDataViewPrefs()).toEqual({ voiceChips: true, speechRails: true, labelMode: "project" })
  })

  it("stores a change on this device and reads it back after a reload", () => {
    setBibleDataViewPrefs({ speechRails: false })
    resetBibleDataViewPrefsCacheForTests()
    expect(getBibleDataViewPrefs()).toEqual({ ...DEFAULT_BIBLE_DATA_VIEW_PREFS, speechRails: false })
  })

  it("reads an unreadable value as the defaults", () => {
    localStorage.setItem(KEY, "{not json")
    expect(getBibleDataViewPrefs()).toEqual(DEFAULT_BIBLE_DATA_VIEW_PREFS)
  })

  it("keeps the good fields of a partly wrong value and defaults the rest", () => {
    localStorage.setItem(KEY, JSON.stringify({ voiceChips: false, speechRails: "no", labelMode: "klingon" }))
    expect(getBibleDataViewPrefs()).toEqual({ voiceChips: false, speechRails: true, labelMode: "project" })
  })
})
