import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
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

describe("workspace dock persistence (FRO-308)", () => {
  beforeEach(() => localStorage.clear())

  it("reopens the tab a project last had open, so reload doesn't reset to Files", () => {
    localStorage.setItem("aquilla:dockTab:p1", "voices")
    const { result } = renderHook(() => useWorkspaceDockTabs(false, "p1"))
    expect(result.current.activeTab).toBe("voices")
  })

  it("remembers the last real tab but never stores a collapse", () => {
    const { result } = renderHook(() => useWorkspaceDockTabs(false, "p1"))
    act(() => result.current.setActiveTab("search"))
    act(() => result.current.setActiveTab(null))
    expect(localStorage.getItem("aquilla:dockTab:p1")).toBe("search")
  })

  it("switching projects restores the other project's tab, not this one's", () => {
    localStorage.setItem("aquilla:dockTab:p2", "voices")
    const { result, rerender } = renderHook(
      ({ id }) => useWorkspaceDockTabs(false, id),
      { initialProps: { id: "p1" } },
    )
    act(() => result.current.setActiveTab("search"))
    rerender({ id: "p2" })
    expect(result.current.activeTab).toBe("voices")
    expect(localStorage.getItem("aquilla:dockTab:p1")).toBe("search")
  })
})

describe("programmatic dock switches during the Agent takeover", () => {
  // The workbench's "Choose file" picker opens Files for the user. Leaving the
  // Agent surface must still restore the panel they had before, or they are
  // stranded on Files (2026-08-28 live-review audit).
  it("restores the saved panel after a programmatic switch", () => {
    const { result, rerender } = renderHook(
      ({ agent }) => useWorkspaceDockTabs(agent),
      { initialProps: { agent: false } },
    )
    act(() => result.current.setActiveTab("search"))
    rerender({ agent: true })
    act(() => result.current.showProgrammatically("files"))
    rerender({ agent: false })
    expect(result.current.activeTab).toBe("search")
  })

  it("keeps a manual rail pick made after a programmatic switch", () => {
    const { result, rerender } = renderHook(
      ({ agent }) => useWorkspaceDockTabs(agent),
      { initialProps: { agent: false } },
    )
    act(() => result.current.setActiveTab("search"))
    rerender({ agent: true })
    act(() => result.current.showProgrammatically("files"))
    act(() => result.current.setActiveTab("voices"))
    rerender({ agent: false })
    expect(result.current.activeTab).toBe("voices")
  })
})
