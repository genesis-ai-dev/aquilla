import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useDockTabs } from "./useDockTabs"

describe("useDockTabs", () => {
  it("remembers the selected panel when hidden and restored", () => {
    const { result } = renderHook(() => useDockTabs("files"))
    act(() => result.current.setActiveTab("agent"))
    act(() => result.current.setActiveTab(null))
    expect(result.current.activeTab).toBeNull()
    expect(result.current.lastOpenTab).toBe("agent")
    act(() => result.current.setActiveTab(result.current.lastOpenTab))
    expect(result.current.activeTab).toBe("agent")
  })

  it("preserves history through functional and batched updates", () => {
    const { result } = renderHook(() => useDockTabs("agent"))
    act(() => {
      result.current.setActiveTab((current) => current === "agent" ? "search" : "files")
      result.current.setActiveTab(null)
    })
    expect(result.current.activeTab).toBeNull()
    expect(result.current.lastOpenTab).toBe("search")
  })

  it("does not let automatic panel choices reopen or replace a hidden panel", () => {
    const { result } = renderHook(() => useDockTabs("files"))
    act(() => result.current.setActiveTab(null))
    act(() => result.current.selectVisibleTab("voices"))
    expect(result.current.activeTab).toBeNull()
    expect(result.current.lastOpenTab).toBe("files")
    act(() => result.current.setActiveTab("files"))
    act(() => result.current.selectVisibleTab("voices"))
    expect(result.current.activeTab).toBe("voices")
  })
})
