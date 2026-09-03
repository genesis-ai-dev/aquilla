import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useTargetKeyTermHighlightPreference } from "./useTargetKeyTermHighlightPreference"

describe("useTargetKeyTermHighlightPreference", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("defaults to never and persists a project-scoped choice", () => {
    const { result, unmount } = renderHook(() =>
      useTargetKeyTermHighlightPreference("project-a"),
    )

    expect(result.current[0]).toBe("never")

    act(() => result.current[1]("focused"))
    expect(result.current[0]).toBe("focused")
    unmount()

    const restored = renderHook(() =>
      useTargetKeyTermHighlightPreference("project-a"),
    )
    expect(restored.result.current[0]).toBe("focused")
  })

  it("does not share the choice with another project", () => {
    localStorage.setItem("aquilla:targetKeyTermHighlights:project-a", "always")

    const { result } = renderHook(() =>
      useTargetKeyTermHighlightPreference("project-b"),
    )

    expect(result.current[0]).toBe("never")
  })
})
