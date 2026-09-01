import { beforeEach, describe, expect, it } from "vitest"

import {
  getChapterPagePref,
  resetChapterPagePrefCacheForTests,
  setChapterPagePref,
} from "./chapter-page-pref"

const KEY = "aq.chapter-page-pref.v1"

describe("chapter-page-pref (AQU-1087)", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetChapterPagePrefCacheForTests()
  })

  it("returns null when nothing is stored for the file", () => {
    expect(getChapterPagePref("file-1")).toBeNull()
  })

  it("persists the last chapter page per file", () => {
    setChapterPagePref("file-1", { key: "scripture:GEN:3" })
    expect(getChapterPagePref("file-1")).toEqual({ key: "scripture:GEN:3" })
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")["file-1"]).toEqual({
      key: "scripture:GEN:3",
    })
  })

  it("does not cross-contaminate different fileIds", () => {
    setChapterPagePref("file-1", { key: "scripture:GEN:2" })
    setChapterPagePref("file-2", { key: "scripture:EXO:1" })
    expect(getChapterPagePref("file-1")).toEqual({ key: "scripture:GEN:2" })
    expect(getChapterPagePref("file-2")).toEqual({ key: "scripture:EXO:1" })
  })

  it("replaces rather than merging, so a whole-chapter pick drops the subsection", () => {
    setChapterPagePref("file-1", {
      key: "scripture:GEN:2",
      subsectionKey: "scripture:GEN:2:range:g3",
    })
    setChapterPagePref("file-1", { key: "scripture:GEN:3" })
    expect(getChapterPagePref("file-1")).toEqual({ key: "scripture:GEN:3" })
  })

  it("ignores corrupt localStorage and empty keys", () => {
    localStorage.setItem(KEY, "{not json")
    resetChapterPagePrefCacheForTests()
    expect(getChapterPagePref("file-1")).toBeNull()

    setChapterPagePref("file-1", { key: "" })
    expect(getChapterPagePref("file-1")).toBeNull()
  })
})
