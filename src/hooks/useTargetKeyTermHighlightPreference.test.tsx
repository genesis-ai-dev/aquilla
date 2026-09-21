import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useTargetKeyTermHighlightPreference } from "./useTargetKeyTermHighlightPreference"

describe("useTargetKeyTermHighlightPreference", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // AQU-1006 follow-up: the default moved from "never" to "focused".
  // "never" is why approved key terms looked broken in production on
  // 2026-09-04 while working locally — the preference is per project in
  // localStorage, so the person demoing had it on and every attendee got the
  // silent default. A termbase you cannot see enforced reads as a broken one.
  it("defaults to focused and persists a project-scoped choice", () => {
    const { result, unmount } = renderHook(() =>
      useTargetKeyTermHighlightPreference("project-a"),
    )

    expect(result.current[0]).toBe("focused")

    act(() => result.current[1]("always"))
    expect(result.current[0]).toBe("always")
    unmount()

    const restored = renderHook(() =>
      useTargetKeyTermHighlightPreference("project-a"),
    )
    expect(restored.result.current[0]).toBe("always")
  })

  it("does not share the choice with another project", () => {
    localStorage.setItem("aquilla:targetKeyTermHighlights:project-a", "always")

    const { result } = renderHook(() =>
      useTargetKeyTermHighlightPreference("project-b"),
    )

    expect(result.current[0]).toBe("focused")
  })

  it("still honours an explicit 'never', so an opt-out is not overridden", () => {
    // The new default must not reach back and re-enable highlights for someone
    // who deliberately turned them off.
    localStorage.setItem("aquilla:targetKeyTermHighlights:project-c", "never")
    const { result } = renderHook(() =>
      useTargetKeyTermHighlightPreference("project-c"),
    )
    expect(result.current[0]).toBe("never")
  })
})
