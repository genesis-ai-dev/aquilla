import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useCurrentTargetLanes } from "./useCurrentTargetLanes"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt" } }),
}))

const fetchResult = vi.fn()
vi.mock("@/lib/sync/project-settings", () => ({
  fetchProjectSettingsResult: (...args: unknown[]) => fetchResult(...args),
}))

describe("useCurrentTargetLanes", () => {
  it("keeps current target lanes and drops archived and source rows", async () => {
    fetchResult.mockResolvedValue({
      ok: true,
      value: {
        lanes: [
          { id: "src", role: "source", name: "Greek", legacyTag: null, archivedAt: null },
          { id: "ln-es", role: "target", name: "Spanish", legacyTag: "es", archivedAt: null },
          { id: "ln-old", role: "target", name: "Old", legacyTag: "old", archivedAt: "2026-01-01T00:00:00Z" },
        ],
      },
    })
    const { result } = renderHook(() => useCurrentTargetLanes("proj-1"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.lanes).toEqual([{ id: "ln-es", label: "Spanish" }])
    expect(fetchResult).toHaveBeenCalledWith("jwt", "proj-1")
  })

  it("stays empty when the settings load throws, so the form does not invent lanes", async () => {
    fetchResult.mockRejectedValue(new Error("missing"))
    const { result } = renderHook(() => useCurrentTargetLanes("proj-1"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.lanes).toEqual([])
  })
})
