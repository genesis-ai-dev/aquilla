import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { usePersistedToggleSet } from "./useSidebarExpansion"

describe("usePersistedToggleSet (AQU-350)", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("keeps one Set identity when the persisted contents have not changed", () => {
    localStorage.setItem("sidebar:expanded:p1", JSON.stringify(["GEN"]))
    const { result, rerender } = renderHook(() => usePersistedToggleSet("sidebar:expanded:p1"))

    const first = result.current.members
    expect([...first]).toEqual(["GEN"])
    // The mount effect re-reads localStorage; an unchanged read must not hand
    // out a new Set, or every effect depending on it re-fires (in the Files
    // sidebar, that is the per-file progress prefetch sweep).
    rerender()
    expect(result.current.members).toBe(first)
  })

  it("still produces a new Set when the contents actually change", () => {
    const { result } = renderHook(() => usePersistedToggleSet("sidebar:expanded:p1"))
    const first = result.current.members

    act(() => { result.current.toggle("GEN") })

    expect(result.current.members).not.toBe(first)
    expect([...result.current.members]).toEqual(["GEN"])
    expect(JSON.parse(localStorage.getItem("sidebar:expanded:p1") ?? "[]")).toEqual(["GEN"])
  })

  it("re-reads when the storage key changes", () => {
    localStorage.setItem("sidebar:expanded:p1", JSON.stringify(["GEN"]))
    localStorage.setItem("sidebar:expanded:p2", JSON.stringify(["MAT"]))
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => usePersistedToggleSet(key),
      { initialProps: { key: "sidebar:expanded:p1" } },
    )
    expect([...result.current.members]).toEqual(["GEN"])

    rerender({ key: "sidebar:expanded:p2" })
    expect([...result.current.members]).toEqual(["MAT"])
  })
})
