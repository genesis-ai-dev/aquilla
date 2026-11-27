// Sam, Nov 27: with Split into milestones on, the timeline is a window onto
// the film's clock: where it starts, worked out once per milestone.
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import * as programme from "@/lib/timeline/programme"
import { useMilestoneWindowStart } from "./useMilestoneWindowStart"

const line = (id: string, startTime?: number, endTime?: number): CellData =>
  ({ id, fileId: "f1", medium: "text", original: `Words of ${id} here`, translated: "", startTime, endTime }) as unknown as CellData

const whole = [line("a", 0, 4), line("b", 4, 9), line("c", 750, 760), line("d", 760, 1090)]
const NO_TRACKS = { layerSlots: [], layerTrackSlots: [] }
const args = (over: Partial<Parameters<typeof useMilestoneWindowStart>[0]> = {}) => ({
  fileId: "f1", partShown: true, milestoneKey: "m2", followsRecordings: false,
  tracks: NO_TRACKS, shown: whole.slice(2), whole, ...over,
})

describe("useMilestoneWindowStart", () => {
  it("the whole file on the timeline is 0:00", () => {
    const { result } = renderHook(() => useMilestoneWindowStart(args({ partShown: false, shown: whole, milestoneKey: null })))
    expect(result.current).toBe(0)
  })

  it("following the source, the milestone's earliest line", () => {
    const { result } = renderHook(() => useMilestoneWindowStart(args()))
    expect(result.current).toBe(750)
  })

  it("following the recordings, its place in the whole file's layout, laid out once per milestone", () => {
    const expected = programme.layOutProgramme(whole, NO_TRACKS).programme.byCellId.get("c")!.startSec
    expect(expected).toBeGreaterThan(0)
    const spy = vi.spyOn(programme, "layOutProgramme")
    const { result, rerender } = renderHook((p: ReturnType<typeof args>) => useMilestoneWindowStart(p), {
      initialProps: args({ followsRecordings: true }),
    })
    expect(result.current).toBe(expected)
    const calls = spy.mock.calls.length
    expect(calls).toBe(1)
    // A take or an edit on a line (a new array, the same lines): not again.
    rerender(args({ followsRecordings: true, shown: whole.slice(2).map((c) => ({ ...c })) }))
    expect(spy.mock.calls.length).toBe(calls)
    // Another milestone: once more.
    rerender(args({ followsRecordings: true, milestoneKey: "m1", shown: whole.slice(0, 2) }))
    expect(result.current).toBe(0)
    expect(spy.mock.calls.length).toBe(calls + 1)
    spy.mockRestore()
  })
})
