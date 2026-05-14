// Phase 2b: comments stubbed. Smoke-test that the no-op API returns the
// expected empty shape and never throws.

import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { useComments, extractThreadsFromCell } from "./useComments"

describe("useComments (Phase 2b stub)", () => {
  it("returns no-op mutators + empty threads", () => {
    const { result } = renderHook(() => useComments(null, "alice"))
    expect(result.current.threads).toEqual([])
    expect(() => result.current.addThread("c", "msg")).not.toThrow()
    expect(() => result.current.addMessage("c", "t", "msg")).not.toThrow()
    expect(() => result.current.resolveThread("c", "t")).not.toThrow()
    expect(() => result.current.reopenThread("c", "t")).not.toThrow()
  })

  it("extractThreadsFromCell always returns []", () => {
    expect(extractThreadsFromCell(null)).toEqual([])
    expect(extractThreadsFromCell({})).toEqual([])
  })
})
