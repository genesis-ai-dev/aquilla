import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useProjectPlan } from "./useProjectPlan"
import type { PlanUnit } from "@/lib/sync/plan"

const fetchProjectPlan = vi.fn()
const setPlanUnit = vi.fn()
vi.mock("@/lib/sync/plan", () => ({
  fetchProjectPlan: (...a: unknown[]) => fetchProjectPlan(...a),
  setPlanUnit: (...a: unknown[]) => setPlanUnit(...a),
}))

function unit(over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    fileId: "f1", fileName: "Mark", fileRole: null, fileKind: null, sectionKey: "",
    totalCount: 10, filledCount: 4, validatedCount: 1,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null, updatedAt: null, updatedBy: null,
    ...over,
  }
}

const getToken = async () => "tok"

beforeEach(() => {
  fetchProjectPlan.mockReset()
  setPlanUnit.mockReset()
  fetchProjectPlan.mockResolvedValue({ projectId: "p1", lane: "", validationCount: 1, revision: 1, units: [unit()] })
})

describe("useProjectPlan", () => {
  it("loads the plan for a project", async () => {
    const { result } = renderHook(() => useProjectPlan({ projectId: "p1", lane: "", getToken }))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.units).toHaveLength(1)
    expect(result.current.validationCount).toBe(1)
  })

  it("stays idle without a project or a token", async () => {
    const { result } = renderHook(() => useProjectPlan({ projectId: null, lane: "", getToken }))
    expect(result.current.status).toBe("idle")
    expect(fetchProjectPlan).not.toHaveBeenCalled()
  })

  it("re-reads when the language lane changes, because progress is per lane", async () => {
    const { result, rerender } = renderHook((props: { lane: string }) =>
      useProjectPlan({ projectId: "p1", lane: props.lane, getToken }), { initialProps: { lane: "" } })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    rerender({ lane: "fr" })
    await waitFor(() => expect(fetchProjectPlan).toHaveBeenCalledTimes(2))
    expect(fetchProjectPlan.mock.calls[1][2]).toBe("fr")
  })

  it("reports a failed load rather than showing an empty plan", async () => {
    fetchProjectPlan.mockRejectedValue(new Error("HTTP 500"))
    const { result } = renderHook(() => useProjectPlan({ projectId: "p1", lane: "", getToken }))
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.error).toMatch(/500/)
  })

  it("shows a date change before the server answers", async () => {
    // The row must move the moment you pick a date; waiting on a round trip
    // makes the board feel broken.
    let resolve: (u: PlanUnit) => void = () => {}
    setPlanUnit.mockReturnValue(new Promise<PlanUnit>((r) => { resolve = r }))
    const { result } = renderHook(() => useProjectPlan({ projectId: "p1", lane: "", getToken }))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    let pending: Promise<boolean>
    act(() => { pending = result.current.patchUnit({ fileId: "f1", sectionKey: "", targetDate: "2026-11-01" }) })
    await waitFor(() => expect(result.current.units[0].targetDate).toBe("2026-11-01"))

    await act(async () => { resolve(unit({ targetDate: "2026-11-01", updatedBy: "randall" })); await pending })
    expect(result.current.units[0].updatedBy).toBe("randall")
  })

  it("replaces the optimistic guess with the server's answer", async () => {
    // The optimistic doneBy is a guess; provenance comes from the server.
    setPlanUnit.mockResolvedValue(unit({ doneAt: 555, doneBy: "randall" }))
    const { result } = renderHook(() => useProjectPlan({ projectId: "p1", lane: "", getToken }))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(async () => { await result.current.patchUnit({ fileId: "f1", sectionKey: "", done: true }) })
    expect(result.current.units[0]).toMatchObject({ doneAt: 555, doneBy: "randall" })
  })

  it("puts the row back when the write is refused", async () => {
    // A contributor who somehow reaches the control, or a demoted maintainer:
    // the row must not keep a change the server rejected.
    setPlanUnit.mockRejectedValue(new Error("HTTP 403"))
    const { result } = renderHook(() => useProjectPlan({ projectId: "p1", lane: "", getToken }))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.patchUnit({ fileId: "f1", sectionKey: "", targetDate: "2026-11-01" }) })
    expect(ok).toBe(false)
    expect(result.current.units[0].targetDate).toBeNull()
    expect(result.current.error).toMatch(/403/)
  })

  it("leaves other units alone when one is patched", async () => {
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1,
      units: [unit({ fileId: "f1" }), unit({ fileId: "f2", fileName: "Luke" })],
    })
    setPlanUnit.mockResolvedValue(unit({ fileId: "f1", targetDate: "2026-11-01" }))
    const { result } = renderHook(() => useProjectPlan({ projectId: "p1", lane: "", getToken }))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(async () => { await result.current.patchUnit({ fileId: "f1", sectionKey: "", targetDate: "2026-11-01" }) })
    expect(result.current.units[1].targetDate).toBeNull()
    expect(result.current.units[1].fileName).toBe("Luke")
  })

  it("distinguishes two units of the same file by their section key", async () => {
    // A whole-Bible file has 66 units sharing one fileId; patching Genesis
    // must not touch Exodus.
    fetchProjectPlan.mockResolvedValue({
      projectId: "p1", lane: "", validationCount: 1, revision: 1,
      units: [unit({ sectionKey: "GEN" }), unit({ sectionKey: "EXO" })],
    })
    setPlanUnit.mockResolvedValue(unit({ sectionKey: "GEN", targetDate: "2026-11-01" }))
    const { result } = renderHook(() => useProjectPlan({ projectId: "p1", lane: "", getToken }))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(async () => { await result.current.patchUnit({ fileId: "f1", sectionKey: "GEN", targetDate: "2026-11-01" }) })
    expect(result.current.units[0].targetDate).toBe("2026-11-01")
    expect(result.current.units[1].targetDate).toBeNull()
  })

  it("refetches on demand", async () => {
    const { result } = renderHook(() => useProjectPlan({ projectId: "p1", lane: "", getToken }))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    act(() => result.current.refresh())
    await waitFor(() => expect(fetchProjectPlan).toHaveBeenCalledTimes(2))
  })
})
