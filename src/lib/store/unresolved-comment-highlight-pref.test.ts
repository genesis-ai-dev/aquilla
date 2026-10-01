/**
 * AQU-1259 — the unresolved-comment highlight preference.
 *
 * The behaviour worth pinning is the default and the durability, because both
 * are claims the acceptance criteria make: a file nobody has touched must look
 * exactly as it did before this preference existed (so "absent key" has to read
 * as off, not as "unset"), and the reviewer's choice has to survive a reload.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  getUnresolvedCommentHighlight,
  resetUnresolvedCommentHighlightCacheForTests,
  setUnresolvedCommentHighlight,
} from "./unresolved-comment-highlight-pref"

const STORAGE_KEY = "aq.unresolved-comment-highlight.v1"

beforeEach(() => {
  localStorage.clear()
  resetUnresolvedCommentHighlightCacheForTests()
})

describe("unresolved-comment highlight preference", () => {
  it("is off when nothing is stored", () => {
    expect(getUnresolvedCommentHighlight()).toBe(false)
  })

  it("persists only the opt-in, so clearing storage returns to off", () => {
    setUnresolvedCommentHighlight(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("on")

    setUnresolvedCommentHighlight(false)
    // Removed rather than written as "off": a cleared key and an explicit
    // opt-out must be indistinguishable, or a future default flip would treat
    // the two differently.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(getUnresolvedCommentHighlight()).toBe(false)
  })

  it("reads a stored opt-in back after a reload", () => {
    localStorage.setItem(STORAGE_KEY, "on")
    resetUnresolvedCommentHighlightCacheForTests()

    expect(getUnresolvedCommentHighlight()).toBe(true)
  })

  it("treats any other stored value as off", () => {
    localStorage.setItem(STORAGE_KEY, "true")
    resetUnresolvedCommentHighlightCacheForTests()

    expect(getUnresolvedCommentHighlight()).toBe(false)
  })
})
