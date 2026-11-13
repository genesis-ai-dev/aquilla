import { beforeEach, describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import {
  adoptedFilesAwaitingIdmlAlignment,
  clearAdoptedFileIdmlAlignment,
  markAdoptedFilesForIdmlAlignment,
  reloadAdoptedIdmlAlignmentForTests,
  resetAdoptedIdmlAlignmentForTests,
  useAdoptedFilesAwaitingIdmlAlignment,
} from "./link-adopted-align"

beforeEach(() => {
  localStorage.clear()
  resetAdoptedIdmlAlignmentForTests()
})

describe("files a link replaced the source of, awaiting IDML placement", () => {
  // WHY: the link flow runs on the Source & sync page, the placement in the
  // editor — so the record has to outlive the page, be read per project, and
  // disappear file by file as each placement runs.
  it("records files per project, survives a reload, and clears per file", () => {
    markAdoptedFilesForIdmlAlignment("proj-a", ["own-mrk", "own-luk"])
    markAdoptedFilesForIdmlAlignment("proj-a", ["own-luk"])
    markAdoptedFilesForIdmlAlignment("proj-b", ["own-gen"])

    expect(adoptedFilesAwaitingIdmlAlignment("proj-a")).toEqual(["own-mrk", "own-luk"])
    expect(adoptedFilesAwaitingIdmlAlignment("proj-b")).toEqual(["own-gen"])
    expect(adoptedFilesAwaitingIdmlAlignment("proj-c")).toEqual([])

    // A fresh module read (the editor after a navigation or reload).
    reloadAdoptedIdmlAlignmentForTests()
    expect(adoptedFilesAwaitingIdmlAlignment("proj-a")).toEqual(["own-mrk", "own-luk"])

    const { result, rerender } = renderHook(() => useAdoptedFilesAwaitingIdmlAlignment("proj-a"))
    expect(result.current).toEqual(["own-mrk", "own-luk"])
    clearAdoptedFileIdmlAlignment("proj-a", "own-mrk")
    rerender()
    expect(result.current).toEqual(["own-luk"])
    clearAdoptedFileIdmlAlignment("proj-a", "own-luk")
    expect(adoptedFilesAwaitingIdmlAlignment("proj-a")).toEqual([])
    expect(adoptedFilesAwaitingIdmlAlignment("proj-b")).toEqual(["own-gen"])
    clearAdoptedFileIdmlAlignment("proj-b", "own-gen")
    expect(localStorage.getItem("aq.link-adopted-idml-align.v1")).toBeNull()
  })
})
