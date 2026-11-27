// AQU-2711 x AQU-2253 (review, Nov 25): the recorder's lines are fixed when it
// opens and kept until it closes. Next/Prev moves the line it is on, which
// must never swap the list under it (the milestone's heard lines, or the
// whole cue file). The lines themselves stay live: a take just recorded shows.
import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { useLatchedLines } from "./useLatchedLines"

type Line = { id: string; take?: string }
const l = (id: string, take?: string): Line => ({ id, take })

describe("useLatchedLines", () => {
  const cut = [l("c2"), l("c3")]
  const whole = [l("c1"), l("c2"), l("c3"), l("c4")]

  it("keeps the list it opened with while open, whatever the list becomes", () => {
    const hook = renderHook((p: { open: boolean; current: Line[] }) => useLatchedLines(p.open, p.current, whole), {
      initialProps: { open: true, current: cut },
    })
    expect(hook.result.current.map((c) => c.id)).toEqual(["c2", "c3"])
    hook.rerender({ open: true, current: whole })
    expect(hook.result.current.map((c) => c.id)).toEqual(["c2", "c3"])
  })

  it("its lines stay live: a take recorded on one shows", () => {
    const hook = renderHook((p: { live: Line[] }) => useLatchedLines(true, cut, p.live), {
      initialProps: { live: whole },
    })
    hook.rerender({ live: [l("c1"), l("c2", "take-1"), l("c3"), l("c4")] })
    expect(hook.result.current[0].take).toBe("take-1")
  })

  it("closed, it follows the list; opened again, it latches the new one", () => {
    const hook = renderHook((p: { open: boolean; current: Line[] }) => useLatchedLines(p.open, p.current, whole), {
      initialProps: { open: true, current: cut },
    })
    hook.rerender({ open: false, current: whole })
    expect(hook.result.current.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"])
    hook.rerender({ open: true, current: whole })
    hook.rerender({ open: true, current: cut })
    expect(hook.result.current.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"])
  })
})
