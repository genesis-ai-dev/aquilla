// FRO-214: useProjectLifecycle hook tests.
//
// Verifies:
//   1. isFrozen is false for an active project (isActive: true or absent)
//   2. isFrozen is true for an inactive project (isActive: false)
//   3. toggle calls toggleProjectLifecycle and returns ok: true
//   4. toggle reverts on API failure

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useProjectLifecycle } from "./useProjectLifecycle"
import type { ProjectRecord } from "@/lib/parsers/types"

// Mock the API call
const toggleLifecycleMock = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  toggleProjectLifecycle: (...args: unknown[]) => toggleLifecycleMock(...args),
}))

function makeProject(overrides: Partial<Pick<ProjectRecord, "isActive">> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test",
    files: [],
    members: [],
    sourceLanguage: "",
    targetLanguage: "",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as ProjectRecord
}

beforeEach(() => {
  toggleLifecycleMock.mockReset()
})

describe("useProjectLifecycle — isFrozen derivation", () => {
  it("isFrozen is false when isActive is absent (backward compat)", () => {
    const { result } = renderHook(() =>
      useProjectLifecycle("proj-1", makeProject()),
    )
    expect(result.current.isFrozen).toBe(false)
  })

  it("isFrozen is false when isActive is true", () => {
    const { result } = renderHook(() =>
      useProjectLifecycle("proj-1", makeProject({ isActive: true })),
    )
    expect(result.current.isFrozen).toBe(false)
  })

  it("isFrozen is true when isActive is false", () => {
    const { result } = renderHook(() =>
      useProjectLifecycle("proj-1", makeProject({ isActive: false })),
    )
    expect(result.current.isFrozen).toBe(true)
  })

  it("isFrozen is false when project is null (no data yet)", () => {
    const { result } = renderHook(() =>
      useProjectLifecycle("proj-1", null),
    )
    expect(result.current.isFrozen).toBe(false)
  })
})

describe("useProjectLifecycle — toggle", () => {
  it("calls toggleProjectLifecycle with isActive=true when currently frozen", async () => {
    toggleLifecycleMock.mockResolvedValueOnce(undefined)
    const { result } = renderHook(() =>
      useProjectLifecycle("proj-1", makeProject({ isActive: false })),
    )
    expect(result.current.isFrozen).toBe(true)

    let res!: Awaited<ReturnType<typeof result.current.toggle>>
    await act(async () => {
      res = await result.current.toggle("jwt-token")
    })
    expect(toggleLifecycleMock).toHaveBeenCalledWith("jwt-token", "proj-1", true)
    expect(res.ok).toBe(true)
  })

  it("calls toggleProjectLifecycle with isActive=false when currently active", async () => {
    toggleLifecycleMock.mockResolvedValueOnce(undefined)
    const { result } = renderHook(() =>
      useProjectLifecycle("proj-1", makeProject({ isActive: true })),
    )
    expect(result.current.isFrozen).toBe(false)

    let res!: Awaited<ReturnType<typeof result.current.toggle>>
    await act(async () => {
      res = await result.current.toggle("jwt-token")
    })
    expect(toggleLifecycleMock).toHaveBeenCalledWith("jwt-token", "proj-1", false)
    expect(res.ok).toBe(true)
  })

  it("returns ok: false and does not leave isFrozen optimistically set on API failure", async () => {
    toggleLifecycleMock.mockRejectedValueOnce(new Error("network error"))
    const { result } = renderHook(() =>
      useProjectLifecycle("proj-1", makeProject({ isActive: true })),
    )

    let res!: Awaited<ReturnType<typeof result.current.toggle>>
    await act(async () => {
      res = await result.current.toggle("jwt-token")
    })
    expect(res.ok).toBe(false)
    expect((res as { ok: false; message: string }).message).toContain("network error")
    // After failure the hook reverts — isFrozen should be back to the server value
    expect(result.current.isFrozen).toBe(false)
  })

  it("calls onToggled callback with new state on success", async () => {
    toggleLifecycleMock.mockResolvedValueOnce(undefined)
    const onToggled = vi.fn()
    const { result } = renderHook(() =>
      useProjectLifecycle("proj-1", makeProject({ isActive: true }), onToggled),
    )

    await act(async () => {
      await result.current.toggle("jwt-token")
    })
    expect(onToggled).toHaveBeenCalledWith(false)
  })
})
