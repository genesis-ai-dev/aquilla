import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { useSync } from "./useSync"

describe("useSync (Phase 2b stub)", () => {
  it("returns connected:true by default when the browser is online + enabled", () => {
    const { result } = renderHook(() => useSync())
    expect(result.current.connected).toBe(true)
  })

  it("returns connected:false when disabled", () => {
    const { result } = renderHook(() => useSync({ enabled: false }))
    expect(result.current.connected).toBe(false)
  })
})
