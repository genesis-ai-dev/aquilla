/**
 * 2026-08-07 (wire c): the vertical follow driver — the stacked media lens's
 * "table tracks the sounding row" behavior, with the scroll-truce. Tested in
 * isolation with a mutable play-queue stub: the driver's whole contract is
 * "call scrollToCell on the right transitions and stop after a user scroll".
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render } from "@testing-library/react"
import { act } from "react"
import type { MutableRefObject } from "react"

const queueStub = vi.hoisted(() => ({
  runningCellId: null as string | null,
  listeners: new Set<() => void>(),
}))
vi.mock("@/lib/audio/play-queue", async () => {
  const { useSyncExternalStore } = await import("react")
  return {
    useQueueCurrentCellId: () =>
      useSyncExternalStore(
        (l: () => void) => {
          queueStub.listeners.add(l)
          return () => queueStub.listeners.delete(l)
        },
        () => queueStub.runningCellId,
        () => null,
      ),
    useIsQueueCurrentCell: () => false,
  }
})

import { MediaFollowDriver } from "./EditorTable"

const setRunning = (cellId: string | null) => {
  act(() => {
    queueStub.runningCellId = cellId
    for (const l of queueStub.listeners) l()
  })
}

function makeHarness(displayed: string[] = ["a", "b", "c"]) {
  const userScrollListenerRef: MutableRefObject<((opts?: { force?: boolean }) => void) | null> = { current: null }
  const programmaticStampRef: MutableRefObject<number> = { current: 0 }
  const scrolled: string[] = []
  const scrollToCell = vi.fn((cellId: string) => {
    // The table's real scrollToCell stamps before scrolling — mirror that.
    programmaticStampRef.current = performance.now()
    scrolled.push(cellId)
  })
  const onFollowRest = vi.fn()
  const uiWith = (followCommand: { seq: number; intent: "engage" | "release" } | null) => (
    <MediaFollowDriver
      isCellDisplayed={(id) => displayed.includes(id)}
      scrollToCell={scrollToCell}
      userScrollListenerRef={userScrollListenerRef}
      programmaticStampRef={programmaticStampRef}
      followCommand={followCommand}
      onFollowRest={onFollowRest}
    />
  )
  const ui = uiWith(null)
  return { ui, uiWith, userScrollListenerRef, programmaticStampRef, scrolled, scrollToCell, onFollowRest }
}

describe("MediaFollowDriver", () => {
  beforeEach(() => {
    queueStub.runningCellId = null
    queueStub.listeners.clear()
  })

  it("follows the running cell across boundaries", () => {
    const h = makeHarness()
    render(h.ui)
    setRunning("a")
    setRunning("b")
    expect(h.scrolled).toEqual(["a", "b"])
  })

  it("a foreign queue's cell (not displayed here) never scrolls this table", () => {
    const h = makeHarness(["a", "b"])
    render(h.ui)
    setRunning("other-file-cell")
    expect(h.scrolled).toEqual([])
  })

  it("a user scroll outside the stamp window disengages following", () => {
    const h = makeHarness()
    render(h.ui)
    setRunning("a")
    expect(h.scrolled).toEqual(["a"])
    // The user scrolls well after our programmatic scroll settled.
    h.programmaticStampRef.current = performance.now() - 1000
    act(() => h.userScrollListenerRef.current?.())
    setRunning("b")
    expect(h.scrolled).toEqual(["a"]) // no follow after the truce broke
  })

  it("a scroll inside the 250ms stamp window is our own — following survives", () => {
    const h = makeHarness()
    render(h.ui)
    setRunning("a")
    // LegendList settling: scroll events right after scrollToIndex.
    act(() => h.userScrollListenerRef.current?.())
    setRunning("b")
    expect(h.scrolled).toEqual(["a", "b"])
  })

  it("pressing play again (running rising edge) re-engages following", () => {
    const h = makeHarness()
    render(h.ui)
    setRunning("a")
    h.programmaticStampRef.current = performance.now() - 1000
    act(() => h.userScrollListenerRef.current?.())
    setRunning("b")
    expect(h.scrolled).toEqual(["a"]) // disengaged
    setRunning(null) // pause/stop
    setRunning("c") // resume — rising edge
    expect(h.scrolled).toEqual(["a", "c"])
  })

  it("an ENGAGE command revives following after a truce disengage — snapping to the current cell", () => {
    const h = makeHarness()
    const view = render(h.ui)
    setRunning("a")
    h.programmaticStampRef.current = performance.now() - 1000
    act(() => h.userScrollListenerRef.current?.())
    setRunning("b")
    expect(h.scrolled).toEqual(["a"]) // disengaged
    view.rerender(h.uiWith({ seq: 1, intent: "engage" }))
    // Re-engaging brings the CURRENT running cell into view immediately…
    expect(h.scrolled).toEqual(["a", "b"])
    setRunning("c")
    // …and the follow keeps walking from there.
    expect(h.scrolled).toEqual(["a", "b", "c"])
  })

  it("a RELEASE command stops following without any scroll involved", () => {
    const h = makeHarness()
    const view = render(h.ui)
    setRunning("a")
    view.rerender(h.uiWith({ seq: 1, intent: "release" }))
    setRunning("b")
    expect(h.scrolled).toEqual(["a"]) // released by intent, not by truce
  })

  it("a seq is applied once; a fresh seq re-applies even an identical intent", () => {
    const h = makeHarness()
    const view = render(h.ui)
    setRunning("a") // rising edge → following
    view.rerender(h.uiWith({ seq: 1, intent: "release" }))
    setRunning("b")
    expect(h.scrolled).toEqual(["a"]) // released
    // Re-rendering with the SAME seq must not re-apply (no state churn)…
    view.rerender(h.uiWith({ seq: 1, intent: "release" }))
    setRunning("c")
    expect(h.scrolled).toEqual(["a"])
    // …while a fresh seq applies again — here flipping to engage mid-run.
    view.rerender(h.uiWith({ seq: 2, intent: "engage" }))
    expect(h.scrolled).toEqual(["a", "c"]) // snap to current on engage
  })

  it("a command issued BEFORE mount is dead on arrival (lens round-trip must not replay a stale release)", () => {
    const h = makeHarness()
    // The driver mounts with a stale release already in table state (issued
    // while it was unmounted in the Text lens) and the queue ALREADY running.
    render(h.uiWith({ seq: 7, intent: "release" }))
    setRunning("a")
    setRunning("b")
    expect(h.scrolled).toEqual(["a", "b"]) // still following — stale command skipped
  })

  it("a forced user-scroll signal (wheel) disengages even inside the stamp window", () => {
    const h = makeHarness()
    render(h.ui)
    setRunning("a") // scrollToCell stamps fresh
    act(() => h.userScrollListenerRef.current?.({ force: true }))
    setRunning("b")
    expect(h.scrolled).toEqual(["a"]) // wheel escaped mid-glide
  })

  it("the falling edge of running fires onFollowRest (hover lock lifts on pause/stop)", () => {
    const h = makeHarness()
    render(h.ui)
    setRunning("a")
    h.onFollowRest.mockClear()
    setRunning(null) // pause/stop
    expect(h.onFollowRest).toHaveBeenCalled()
  })

  it("a scroll while the queue is quiet never breaks the next session's follow", () => {
    const h = makeHarness()
    render(h.ui)
    act(() => h.userScrollListenerRef.current?.()) // browsing before playback
    setRunning("a")
    expect(h.scrolled).toEqual(["a"])
  })
})
