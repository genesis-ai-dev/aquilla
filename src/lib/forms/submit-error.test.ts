import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useSubmitError } from "./submit-error"

describe("useSubmitError", () => {
  it("keeps clearSubmitError stable across renders", () => {
    const { result, rerender } = renderHook(() => useSubmitError())
    const initialClear = result.current.clearSubmitError

    act(() => result.current.setSubmitError("Try again"))
    rerender()

    expect(result.current.clearSubmitError).toBe(initialClear)
  })

  it("clears the current error", () => {
    const { result } = renderHook(() => useSubmitError())

    act(() => result.current.setSubmitError("Try again"))
    expect(result.current.submitError).toBe("Try again")

    act(() => result.current.clearSubmitError())
    expect(result.current.submitError).toBeNull()
  })
})
