// AQU-2654: the Security page's two "stricter projects" sections read the same
// org-wide route. Mounted together they send one request; a floor that moves
// later still reads again.

import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useStricterProjectCounts } from "./useStricterProjectCounts"

const fetchCounts = vi.hoisted(() => vi.fn())

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "ana" }, loading: false }),
}))
vi.mock("@/lib/sync/org-settings", () => ({
  fetchVisibilityOverrideCounts: (...args: unknown[]) => fetchCounts(...args),
}))

const counts = (roster: number) => ({
  rosterViewMinRole: roster,
  memberProgressViewMinRole: 0,
  importMinRole: 0,
  overrideProjects: { rosterViewMinRole: null, memberProgressViewMinRole: null, importMinRole: null },
})

describe("useStricterProjectCounts", () => {
  beforeEach(() => {
    fetchCounts.mockReset()
  })

  it("two sections mounted together send one request and both get the answer", async () => {
    fetchCounts.mockResolvedValue(counts(2))
    const roster = renderHook(() => useStricterProjectCounts(7, [300, 500]))
    const imports = renderHook(() => useStricterProjectCounts(7, [600]))
    await waitFor(() => expect(roster.result.current?.rosterViewMinRole).toBe(2))
    await waitFor(() => expect(imports.result.current?.rosterViewMinRole).toBe(2))
    expect(fetchCounts).toHaveBeenCalledTimes(1)
    expect(fetchCounts).toHaveBeenCalledWith("jwt", 7)
  })

  it("reads again when a floor it depends on moves", async () => {
    fetchCounts.mockResolvedValueOnce(counts(2)).mockResolvedValueOnce(counts(5))
    const hook = renderHook(({ floor }) => useStricterProjectCounts(7, [floor]), { initialProps: { floor: 300 } })
    await waitFor(() => expect(hook.result.current?.rosterViewMinRole).toBe(2))

    hook.rerender({ floor: 500 })
    // The old answer is for the old floor: nothing is shown until the new one lands.
    expect(hook.result.current).toBeNull()
    await waitFor(() => expect(hook.result.current?.rosterViewMinRole).toBe(5))
    expect(fetchCounts).toHaveBeenCalledTimes(2)
  })

  it("sends nothing without an org", async () => {
    renderHook(() => useStricterProjectCounts(null, [300]))
    await act(async () => {})
    expect(fetchCounts).not.toHaveBeenCalled()
  })
})
