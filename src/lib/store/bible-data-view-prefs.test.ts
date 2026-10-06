// AQU-1687, AQU-1689 — each person's Bible data view options.
//
// What this protects: the options default to showing Voices and Who's Who
// (the project decides whether they exist; a person only hides what they
// show), and a stored value that is missing, unreadable or of the wrong type
// can never switch on something the person did not choose. It falls back to
// the default, one field at a time.

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
  it("shows chips, rails, mention highlights on hover and hints for named people, until the person changes them", () => {
    expect(getBibleDataViewPrefs()).toEqual({
      voiceChips: true,
      speechRails: true,
      labelMode: "project",
      whosWhoHighlights: "hover",
      impliedSubjectHints: "names",
    })
  })

  it("stores a change on this device and reads it back after a reload", () => {
    setBibleDataViewPrefs({ speechRails: false, whosWhoHighlights: "always", impliedSubjectHints: "off" })
    resetBibleDataViewPrefsCacheForTests()
    expect(getBibleDataViewPrefs()).toEqual({
      ...DEFAULT_BIBLE_DATA_VIEW_PREFS,
      speechRails: false,
      whosWhoHighlights: "always",
      impliedSubjectHints: "off",
    })
  })

  it("reads an unreadable value as the defaults", () => {
    localStorage.setItem(KEY, "{not json")
    expect(getBibleDataViewPrefs()).toEqual(DEFAULT_BIBLE_DATA_VIEW_PREFS)
  })

  it("keeps the good fields of a partly wrong value and defaults the rest", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        voiceChips: false,
        speechRails: "no",
        labelMode: "klingon",
        whosWhoHighlights: "sometimes",
        impliedSubjectHints: "all",
      }),
    )
    expect(getBibleDataViewPrefs()).toEqual({
      voiceChips: false,
      speechRails: true,
      labelMode: "project",
      whosWhoHighlights: "hover",
      impliedSubjectHints: "all",
    })
  })

  // A value stored before AQU-1689 has no Who's Who fields: they read as
  // their defaults, and the AQU-1687 choices survive.
  it("reads an AQU-1687 value with the new options at their defaults", () => {
    localStorage.setItem(KEY, JSON.stringify({ voiceChips: false, speechRails: true, labelMode: "english" }))
    expect(getBibleDataViewPrefs()).toEqual({
      voiceChips: false,
      speechRails: true,
      labelMode: "english",
      whosWhoHighlights: "hover",
      impliedSubjectHints: "names",
    })
  })
})
