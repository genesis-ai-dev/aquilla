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
    expect(result.current?.startSec).toBe(0)
  })

  it("following the source, the milestone's earliest line", () => {
    const { result } = renderHook(() => useMilestoneWindowStart(args()))
    expect(result.current?.startSec).toBe(750)
  })

  it("following the recordings, its place in the whole file's layout, laid out once per milestone", () => {
    const expected = programme.layOutProgramme(whole, NO_TRACKS).programme.byCellId.get("c")!.startSec
    expect(expected).toBeGreaterThan(0)
    const spy = vi.spyOn(programme, "layOutProgramme")
    const { result, rerender } = renderHook((p: ReturnType<typeof args>) => useMilestoneWindowStart(p), {
      initialProps: args({ followsRecordings: true }),
    })
    expect(result.current?.startSec).toBe(expected)
    const calls = spy.mock.calls.length
    expect(calls).toBe(1)
    // A take or an edit on a line (a new array, the same lines): not again.
    rerender(args({ followsRecordings: true, shown: whole.slice(2).map((c) => ({ ...c })) }))
    expect(spy.mock.calls.length).toBe(calls)
    // Another milestone: once more.
    rerender(args({ followsRecordings: true, milestoneKey: "m1", shown: whole.slice(0, 2) }))
    expect(result.current?.startSec).toBe(0)
    expect(spy.mock.calls.length).toBe(calls + 1)
    spy.mockRestore()
  })
})

describe("useMilestoneWindowStart names the milestone its start is for", () => {
  // Evidence pass, Nov 27: following the recordings, turning to milestone 2
  // gave one render with milestone 2's key and milestone 1's start (0:00); the
  // timeline took that as "the playhead is already inside" and never brought
  // the playhead and the film to milestone 2's start.
  it("following the recordings, never reports a milestone with another one's start", () => {
    const expected = programme.layOutProgramme(whole, NO_TRACKS).programme.byCellId.get("c")!.startSec
    const seen: Array<{ startSec: number; milestoneKey: string | null } | null> = []
    const { rerender } = renderHook((p: ReturnType<typeof args>) => {
      const r = useMilestoneWindowStart(p)
      seen.push(r)
      return r
    }, { initialProps: args({ followsRecordings: true, milestoneKey: "m1", shown: whole.slice(0, 2) }) })
    rerender(args({ followsRecordings: true }))
    const forM2 = seen.filter((r) => r?.milestoneKey === "m2")
    expect(forM2.length).toBeGreaterThan(0)
    expect(forM2.every((r) => r!.startSec === expected)).toBe(true)
    // The render before it was worked out kept milestone 1's start, under milestone 1's name.
    expect(seen.filter((r) => r?.milestoneKey === "m1").every((r) => r!.startSec === 0)).toBe(true)
  })

  it("following the source, its milestone at once", () => {
    const { result } = renderHook(() => useMilestoneWindowStart(args()))
    expect(result.current).toEqual({ startSec: 750, milestoneKey: "m2" })
  })
})

describe("useMilestoneWindowStart following the source", () => {
  it("follows a first line dragged earlier, so it never slides off the timeline", () => {
    const { result, rerender } = renderHook((p: ReturnType<typeof args>) => useMilestoneWindowStart(p), { initialProps: args() })
    expect(result.current?.startSec).toBe(750)
    const moved = [line("c", 740, 760), whole[3]]
    rerender(args({ shown: moved, whole: [whole[0], whole[1], ...moved] }))
    expect(result.current?.startSec).toBe(740)
  })
})
