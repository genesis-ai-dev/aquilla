import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useWorkspaceDockTabs } from "./useWorkspaceDockTabs"

describe("workspace dock navigation", () => {
  it("keeps a hidden sidebar closed when entering and leaving Agent", () => {
    const { result, rerender } = renderHook(
      ({ agent }) => useWorkspaceDockTabs(agent),
      { initialProps: { agent: false } },
    )
    act(() => result.current.setActiveTab(null))
    rerender({ agent: true })
    expect(result.current.activeTab).toBeNull()
    expect(result.current.lastOpenTab).toBe("files")
    rerender({ agent: false })
    expect(result.current.activeTab).toBeNull()
    expect(result.current.lastOpenTab).toBe("files")
  })

  it("does not undo a manual collapse made inside Agent", () => {
    const { result, rerender } = renderHook(
      ({ agent }) => useWorkspaceDockTabs(agent),
      { initialProps: { agent: false } },
    )
    rerender({ agent: true })
    expect(result.current.activeTab).toBe("agent")
    act(() => result.current.setActiveTab(null))
    rerender({ agent: false })
    expect(result.current.activeTab).toBeNull()
    expect(result.current.lastOpenTab).toBe("agent")
  })

  it("keeps automatic context selection for an already-visible sidebar", () => {
    const { result, rerender } = renderHook(
      ({ agent }) => useWorkspaceDockTabs(agent),
      { initialProps: { agent: false } },
    )
    rerender({ agent: true })
    expect(result.current.activeTab).toBe("agent")
    rerender({ agent: false })
    expect(result.current.activeTab).toBe("files")
  })

  it("preserves a manually chosen panel rather than restoring a different one", () => {
    const { result, rerender } = renderHook(
      ({ agent }) => useWorkspaceDockTabs(agent),
      { initialProps: { agent: false } },
    )
    rerender({ agent: true })
    act(() => result.current.setActiveTab("search"))
    rerender({ agent: false })
    expect(result.current.activeTab).toBe("search")
  })
})
