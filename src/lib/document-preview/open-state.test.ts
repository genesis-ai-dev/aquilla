import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useDocumentPreviewOpen, writeDocumentPreviewOpen } from "./open-state"

describe("document preview open state", () => {
  beforeEach(() => window.localStorage.clear())

  // The workspace keeps no state for the panel: the rail button writes the
  // flag, and the workspace must hear it, or the click would do nothing.
  it("tells a mounted reader when the panel is opened or closed", () => {
    const { result } = renderHook(() => useDocumentPreviewOpen("p1"))
    expect(result.current).toBe(false)
    act(() => writeDocumentPreviewOpen("p1", true))
    expect(result.current).toBe(true)
    act(() => writeDocumentPreviewOpen("p1", false))
    expect(result.current).toBe(false)
  })

  // The flag is per project: opening the preview in one project must not
  // open it in the next one the translator visits.
  it("keeps each project's flag apart, and is closed without a project", () => {
    writeDocumentPreviewOpen("p1", true)
    expect(renderHook(() => useDocumentPreviewOpen("p2")).result.current).toBe(false)
    expect(renderHook(() => useDocumentPreviewOpen(undefined)).result.current).toBe(false)
    expect(renderHook(() => useDocumentPreviewOpen("p1")).result.current).toBe(true)
  })
})
