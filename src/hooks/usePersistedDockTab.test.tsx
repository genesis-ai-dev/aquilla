import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { usePersistedDockTab } from "./usePersistedDockTab"

const PROJECT_A = "project-a"
const PROJECT_B = "project-b"

beforeEach(() => {
  localStorage.clear()
})

describe("usePersistedDockTab", () => {
  it("defaults to files when nothing is stored", () => {
    const { result } = renderHook(() => usePersistedDockTab(PROJECT_A))
    expect(result.current[0]).toBe("files")
  })

  it("restores the stored tab on mount", () => {
    localStorage.setItem(`aquilla:dockTab:${PROJECT_A}`, "voices")
    const { result } = renderHook(() => usePersistedDockTab(PROJECT_A))
    expect(result.current[0]).toBe("voices")
  })

  it("persists a user-selected tab", () => {
    const { result } = renderHook(() => usePersistedDockTab(PROJECT_A))
    act(() => {
      result.current[1]("search")
    })
    expect(result.current[0]).toBe("search")
    expect(localStorage.getItem(`aquilla:dockTab:${PROJECT_A}`)).toBe("search")
  })

  it("does not persist collapse, so the last tab remains stored", () => {
    const { result } = renderHook(() => usePersistedDockTab(PROJECT_A))
    act(() => {
      result.current[1]("agent")
    })
    act(() => {
      result.current[1](null)
    })
    expect(result.current[0]).toBeNull()
    expect(localStorage.getItem(`aquilla:dockTab:${PROJECT_A}`)).toBe("agent")
  })

  it("persists a functional update", () => {
    const { result } = renderHook(() => usePersistedDockTab(PROJECT_A))
    act(() => {
      result.current[1]((cur) => (cur === "files" ? "voices" : cur))
    })
    expect(result.current[0]).toBe("voices")
    expect(localStorage.getItem(`aquilla:dockTab:${PROJECT_A}`)).toBe("voices")
  })

  it("reloads from storage when the project changes without clobbering the previous project", async () => {
    localStorage.setItem(`aquilla:dockTab:${PROJECT_A}`, "search")
    localStorage.setItem(`aquilla:dockTab:${PROJECT_B}`, "voices")
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => usePersistedDockTab(id),
      { initialProps: { id: PROJECT_A } },
    )
    expect(result.current[0]).toBe("search")

    rerender({ id: PROJECT_B })
    await waitFor(() => {
      expect(result.current[0]).toBe("voices")
    })
    expect(localStorage.getItem(`aquilla:dockTab:${PROJECT_A}`)).toBe("search")
  })
})
