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

  // AQU-2635: the former default lane of a migrated Codex project records no
  // language and no name, and its tag is ''. It used to come back labelled "",
  // so the picker drew a bare checkbox and the grant sentence — which drops
  // blank lane labels — read "every language lane" for a one-lane grant.
  // The label resolves through the real message catalog (no I18nProvider is
  // mounted, so useI18n falls back to the English source), which also guards
  // the key itself against being renamed away.
  it("labels a lane that records no language with the main-language fallback", async () => {
    fetchResult.mockResolvedValue({
      ok: true,
      value: {
        lanes: [
          { id: "ln-main", role: "target", name: "", language: "", legacyTag: "", archivedAt: null },
        ],
      },
    })
    const { result } = renderHook(() => useCurrentTargetLanes("proj-2"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.lanes).toEqual([{ id: "ln-main", label: "Main language" }])
  })

  it("never labels a lane with an opaque lane id", async () => {
    fetchResult.mockResolvedValue({
      ok: true,
      value: {
        lanes: [
          { id: "a3f09c1e", role: "target", name: "", language: "", legacyTag: "a3f09c1e", archivedAt: null },
        ],
      },
    })
    const { result } = renderHook(() => useCurrentTargetLanes("proj-3"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.lanes).toEqual([{ id: "a3f09c1e", label: "Main language" }])
  })

  it("prefers the row's language when only the name is blank", async () => {
    fetchResult.mockResolvedValue({
      ok: true,
      value: {
        lanes: [
          { id: "ln-prs", role: "target", name: "", language: "Dari", legacyTag: "", archivedAt: null },
        ],
      },
    })
    const { result } = renderHook(() => useCurrentTargetLanes("proj-4"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.lanes).toEqual([{ id: "ln-prs", label: "Dari" }])
  })
})
