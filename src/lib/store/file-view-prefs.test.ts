/**
 * AQU-251: per-file font size preference store tests.
 *
 * Tests verify that:
 *   - getFileViewPref returns empty object when nothing is stored
 *   - setFileViewPref persists and is immediately reflected by getFileViewPref
 *   - values are bounded by MIN/MAX_FONT_SIZE (the store itself does not clamp —
 *     clamping is the UI's responsibility; these tests document that raw values
 *     are stored as-is so callers can rely on the stored value being what they wrote)
 *   - writing undefined keys does not pollute the stored object
 */

import { createElement, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { describe, it, expect, beforeEach } from "vitest"
import { FONT_SIZE_STORAGE_KEY, FontSizeProvider, useFontSizeScale } from "@/branding/FontSize"
import {
  getFileViewPref,
  setFileViewPref,
  resolveFontSizes,
  useFileFontSizes,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
} from "./file-view-prefs"

function FontSizeWrapper({ children }: { children: ReactNode }) {
  return createElement(FontSizeProvider, null, children)
}

// Reset localStorage between tests so state doesn't bleed across cases.
beforeEach(() => {
  localStorage.clear()
  document.documentElement.style.removeProperty("font-size")
})

describe("file-view-prefs store (AQU-251)", () => {
  it("returns an empty object for an unknown fileId", () => {
    const prefs = getFileViewPref("unknown-file-id")
    expect(prefs).toEqual({})
  })

  it("persists a fontSize and returns it via getFileViewPref", () => {
    setFileViewPref("file-abc", { fontSize: 16 })
    const prefs = getFileViewPref("file-abc")
    expect(prefs.fontSize).toBe(16)
  })

  it("does not cross-contaminate different fileIds", () => {
    setFileViewPref("file-1", { fontSize: 12 })
    setFileViewPref("file-2", { fontSize: 20 })
    expect(getFileViewPref("file-1").fontSize).toBe(12)
    expect(getFileViewPref("file-2").fontSize).toBe(20)
  })

  it("merges patches — does not wipe unrelated keys", () => {
    setFileViewPref("file-xyz", { fontSize: 15 })
    // A future patch with a different key should not erase fontSize.
    setFileViewPref("file-xyz", { fontSize: 15 })
    expect(getFileViewPref("file-xyz").fontSize).toBe(15)
  })

  it("MIN_FONT_SIZE and MAX_FONT_SIZE are sane bounds (11..22)", () => {
    expect(MIN_FONT_SIZE).toBeLessThan(14)     // smaller than default
    expect(MAX_FONT_SIZE).toBeGreaterThan(14)  // larger than default
    expect(MIN_FONT_SIZE).toBeGreaterThan(0)
  })
})

describe("per-side font size resolution", () => {
  it("defaults both sides to 14 when nothing is stored", () => {
    expect(resolveFontSizes({})).toEqual({ source: 14, target: 14 })
  })

  it("resolves source and target independently — Hebrew source can be larger than Latin target", () => {
    setFileViewPref("file-heb", { sourceFontSize: 20, targetFontSize: 13 })
    const sizes = resolveFontSizes(getFileViewPref("file-heb"))
    expect(sizes.source).toBe(20)
    expect(sizes.target).toBe(13)
  })

  it("falls back to the legacy single fontSize for both sides (pre-split prefs)", () => {
    setFileViewPref("file-legacy", { fontSize: 18 })
    expect(resolveFontSizes(getFileViewPref("file-legacy"))).toEqual({ source: 18, target: 18 })
  })

  it("a per-side value overrides the legacy fontSize only for its own side", () => {
    setFileViewPref("file-mixed", { fontSize: 18, sourceFontSize: 22 })
    const sizes = resolveFontSizes(getFileViewPref("file-mixed"))
    expect(sizes.source).toBe(22) // explicit per-side wins
    expect(sizes.target).toBe(18) // legacy value still honored where unset
  })
})

describe("app-wide font size vs per-file override (AQU-1170)", () => {
  it("scales untouched files with the app font size", () => {
    expect(resolveFontSizes({}, "small")).toEqual({ source: 12, target: 12 })
    expect(resolveFontSizes({}, "default")).toEqual({ source: 14, target: 14 })
    expect(resolveFontSizes({}, "large")).toEqual({ source: 16, target: 16 })
    expect(resolveFontSizes({}, "extra-large")).toEqual({ source: 18, target: 18 })
  })

  it("keeps an explicit per-file size at every app scale", () => {
    setFileViewPref("file-explicit-1170", { targetFontSize: 13 })
    const prefs = getFileViewPref("file-explicit-1170")
    expect(resolveFontSizes(prefs, "small")).toEqual({ source: 12, target: 13 })
    expect(resolveFontSizes(prefs, "default")).toEqual({ source: 14, target: 13 })
    expect(resolveFontSizes(prefs, "large")).toEqual({ source: 16, target: 13 })
    expect(resolveFontSizes(prefs, "extra-large")).toEqual({ source: 18, target: 13 })
  })

  it("a View-settings step from the scaled default pins that exact px", () => {
    expect(resolveFontSizes({}, "large")).toEqual({ source: 16, target: 16 })
    setFileViewPref("file-step-1170", { targetFontSize: 17 })
    expect(resolveFontSizes(getFileViewPref("file-step-1170"), "small")).toEqual({
      source: 12,
      target: 17,
    })
  })

  it("at Default, customized files still render their stored px", () => {
    setFileViewPref("file-custom-default-1170", { sourceFontSize: 20, targetFontSize: 13 })
    expect(resolveFontSizes(getFileViewPref("file-custom-default-1170"), "default")).toEqual({
      source: 20,
      target: 13,
    })
  })

  it("useFileFontSizes updates untouched files live when the app scale changes", () => {
    const { result } = renderHook(
      () => ({
        sizes: useFileFontSizes("hook-untouched-1170"),
        font: useFontSizeScale(),
      }),
      { wrapper: FontSizeWrapper },
    )
    expect(result.current.sizes).toEqual({ source: 14, target: 14 })
    act(() => { result.current.font.setScale("large") })
    expect(result.current.sizes).toEqual({ source: 16, target: 16 })
    expect(localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe("large")
    act(() => { result.current.font.setScale("extra-large") })
    expect(result.current.sizes).toEqual({ source: 18, target: 18 })
  })

  it("useFileFontSizes keeps an explicit target size while the source tracks the scale", () => {
    setFileViewPref("hook-mixed-1170", { targetFontSize: 13 })
    const { result } = renderHook(
      () => ({
        sizes: useFileFontSizes("hook-mixed-1170"),
        font: useFontSizeScale(),
      }),
      { wrapper: FontSizeWrapper },
    )
    act(() => { result.current.font.setScale("large") })
    expect(result.current.sizes).toEqual({ source: 16, target: 13 })
  })
})
