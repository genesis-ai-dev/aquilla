import { describe, expect, it } from "vitest"
import {
  flattenChapterDestinations,
  isChapterPageComplete,
  nextChapterDestination,
} from "./chapter-navigation"

const cell = (
  original: string,
  translated: string,
  status: "empty" | "unvalidated" | "validated" = translated ? "unvalidated" : "empty",
) => ({ original, translated, status })

describe("isChapterPageComplete (AQU-1087)", () => {
  it("is false while any source cell still has no translation", () => {
    expect(isChapterPageComplete({
      trigger: "allTranslated",
      cells: [cell("In the beginning", "Au commencement"), cell("the earth", "")],
    })).toBe(false)
  })

  it("is true when every source cell has a translation", () => {
    expect(isChapterPageComplete({
      trigger: "allTranslated",
      cells: [cell("In the beginning", "Au commencement"), cell("the earth", "la terre")],
    })).toBe(true)
  })

  it("skips empty-source rows so a blank heading cannot block the chapter", () => {
    expect(isChapterPageComplete({
      trigger: "allTranslated",
      cells: [cell("", ""), cell("In the beginning", "Au commencement")],
    })).toBe(true)
  })

  it("requires validation when the trigger is allValidated", () => {
    expect(isChapterPageComplete({
      trigger: "allValidated",
      cells: [cell("In the beginning", "Au commencement", "unvalidated")],
    })).toBe(false)
    expect(isChapterPageComplete({
      trigger: "allValidated",
      cells: [cell("In the beginning", "Au commencement", "validated")],
    })).toBe(true)
  })

  it("never completes on the manual trigger", () => {
    expect(isChapterPageComplete({
      trigger: "manual",
      cells: [cell("In the beginning", "Au commencement", "validated")],
    })).toBe(false)
  })

  it("is false when the page has no translatable cells", () => {
    expect(isChapterPageComplete({
      trigger: "allTranslated",
      cells: [cell("", "")],
    })).toBe(false)
  })
})

describe("nextChapterDestination (AQU-1087)", () => {
  const destinations = flattenChapterDestinations([
    { key: "scripture:GEN:1", label: "Genesis 1" },
    { key: "scripture:GEN:2", label: "Genesis 2" },
    { key: "scripture:GEN:3", label: "Genesis 3" },
  ])

  it("returns the following chapter", () => {
    expect(nextChapterDestination(destinations, "scripture:GEN:1")).toEqual({
      key: "scripture:GEN:2",
      label: "Genesis 2",
    })
  })

  it("returns null on the last chapter", () => {
    expect(nextChapterDestination(destinations, "scripture:GEN:3")).toBeNull()
  })

  it("steps through subsections before the next chapter", () => {
    const withRanges = flattenChapterDestinations([
      {
        key: "ch1",
        label: "Chapter 1",
        subsections: [{ key: "r1" }, { key: "r2" }],
      },
      { key: "ch2", label: "Chapter 2" },
    ])
    expect(nextChapterDestination(withRanges, "ch1", "r1")).toEqual({
      key: "ch1",
      label: "Chapter 1",
      subsectionKey: "r2",
    })
    expect(nextChapterDestination(withRanges, "ch1", "r2")).toEqual({
      key: "ch2",
      label: "Chapter 2",
    })
  })
})
