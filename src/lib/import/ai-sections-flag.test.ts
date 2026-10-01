import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  AI_SECTION_MILESTONES_STORAGE_KEY,
  areAiSectionMilestonesEnabled,
  setAiSectionMilestonesEnabled,
} from "./ai-sections-flag"

describe("AI section milestones kill switch", () => {
  beforeEach(() => {
    localStorage.removeItem(AI_SECTION_MILESTONES_STORAGE_KEY)
  })

  afterEach(() => {
    setAiSectionMilestonesEnabled(false)
    localStorage.removeItem(AI_SECTION_MILESTONES_STORAGE_KEY)
  })

  it("is off until the eval clears", () => {
    // The ticket makes the eval a precondition for changing what a translator
    // navigates by. This test is the promise; flipping the default means
    // deleting it in the PR that posts the numbers.
    expect(localStorage.getItem(AI_SECTION_MILESTONES_STORAGE_KEY)).toBeNull()
    expect(areAiSectionMilestonesEnabled()).toBe(false)
  })

  it("persists an explicit choice both ways", () => {
    setAiSectionMilestonesEnabled(true)
    expect(areAiSectionMilestonesEnabled()).toBe(true)
    expect(localStorage.getItem(AI_SECTION_MILESTONES_STORAGE_KEY)).toBe("1")

    setAiSectionMilestonesEnabled(false)
    expect(areAiSectionMilestonesEnabled()).toBe(false)
    expect(localStorage.getItem(AI_SECTION_MILESTONES_STORAGE_KEY)).toBe("0")
  })

  it("keeps the choice in memory when storage refuses the write", () => {
    const setItem = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error("storage disabled")
    }
    try {
      setAiSectionMilestonesEnabled(true)
      expect(areAiSectionMilestonesEnabled()).toBe(true)
    } finally {
      localStorage.setItem = setItem
    }
  })
})
