import { beforeEach, describe, expect, it } from "vitest"

import {
  applyVisibleStyleSegmentChrome,
  cssContentString,
  getVisibleStyleSegments,
  resetVisibleStyleSegmentsCacheForTests,
  setVisibleStyleSegments,
} from "./visible-style-segments-pref"

const STORAGE_KEY = "aq.visible-style-segments.v1"

const LABELS = {
  regular: "Regular",
  bold: "Bold",
  italic: "Italic",
  boldItalic: "Bold italic",
}

beforeEach(() => {
  localStorage.clear()
  resetVisibleStyleSegmentsCacheForTests()
  document.documentElement.removeAttribute("data-visible-style-segments")
  document.documentElement.removeAttribute("style")
})

describe("visible style segments preference", () => {
  it("is off when nothing is stored", () => {
    expect(getVisibleStyleSegments()).toBe(false)
  })

  it("persists only the opt-in, so clearing storage returns to off", () => {
    setVisibleStyleSegments(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("on")
    expect(getVisibleStyleSegments()).toBe(true)

    setVisibleStyleSegments(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(getVisibleStyleSegments()).toBe(false)
  })

  it("reads a value written by a previous session", () => {
    localStorage.setItem(STORAGE_KEY, "on")
    resetVisibleStyleSegmentsCacheForTests()
    expect(getVisibleStyleSegments()).toBe(true)
  })

  it("quotes labels that contain CSS string characters", () => {
    expect(cssContentString('Say "hi"')).toBe('"Say \\"hi\\""')
  })

  it("publishes the mode and the empty-slot labels on the document", () => {
    applyVisibleStyleSegmentChrome(true, LABELS)
    expect(document.documentElement.hasAttribute("data-visible-style-segments")).toBe(true)
    expect(document.documentElement.style.getPropertyValue("--aq-style-label-bold")).toBe('"Bold"')

    applyVisibleStyleSegmentChrome(false, LABELS)
    expect(document.documentElement.hasAttribute("data-visible-style-segments")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--aq-style-label-bold")).toBe("")
  })
})
