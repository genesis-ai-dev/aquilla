import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import {
  translateAsReadStorageKey,
  useTranslateAsReadPreference,
} from "./useTranslateAsReadPreference"

describe("useTranslateAsReadPreference", () => {
  beforeEach(() => localStorage.clear())

  it("survives remounts for the same project", () => {
    const first = renderHook(() => useTranslateAsReadPreference("p1"))
    act(() => first.result.current[1](true))
    expect(localStorage.getItem(translateAsReadStorageKey("p1"))).toBe("true")
    first.unmount()

    const second = renderHook(() => useTranslateAsReadPreference("p1"))
    expect(second.result.current[0]).toBe(true)
  })

  it("does not silently enable the mode in another project", () => {
    localStorage.setItem(translateAsReadStorageKey("p1"), "true")
    const { result, rerender } = renderHook(
      ({ projectId }) => useTranslateAsReadPreference(projectId),
      { initialProps: { projectId: "p1" } },
    )
    expect(result.current[0]).toBe(true)
    rerender({ projectId: "p2" })
    expect(result.current[0]).toBe(false)
  })
})
