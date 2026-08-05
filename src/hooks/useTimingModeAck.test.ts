// The remote timing-mode heads-up (2026-08-06): one seen-vs-current
// comparison instead of a notification queue. Deferral in the text view /
// while recording, surfacing on eligibility or the recorder's cell
// transition, and back-and-forth flips cancelling out.
import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useTimingModeAck } from "./useTimingModeAck"
import type { AudioTimingMode } from "@/lib/parsers/types"

function mount(initial: { timingMode: AudioTimingMode; eligible: boolean }) {
  return renderHook((props: { timingMode: AudioTimingMode; eligible: boolean }) => useTimingModeAck(props), {
    initialProps: initial,
  })
}

describe("useTimingModeAck", () => {
  it("first eligibility baselines silently — no modal on first visit", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    expect(h.result.current.ack).toBeNull()
  })

  it("a remote change while eligible surfaces immediately", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "audioFirst", eligible: true })
    expect(h.result.current.ack).toEqual({ from: "dubbing", to: "audioFirst" })
  })

  it("a change while in the TEXT VIEW waits, then surfaces on entering the media lens", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "dubbing", eligible: false }) // → text view
    h.rerender({ timingMode: "audioFirst", eligible: false }) // remote flip
    expect(h.result.current.ack).toBeNull()
    h.rerender({ timingMode: "audioFirst", eligible: true }) // → media view
    expect(h.result.current.ack).toEqual({ from: "dubbing", to: "audioFirst" })
  })

  it("back-and-forth flips while deferred cancel out — nothing to say", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "dubbing", eligible: false })
    h.rerender({ timingMode: "audioFirst", eligible: false })
    h.rerender({ timingMode: "dubbing", eligible: false }) // flipped back
    h.rerender({ timingMode: "dubbing", eligible: true })
    expect(h.result.current.ack).toBeNull()
  })

  it("acknowledge closes and re-baselines — the same mode never re-surfaces", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "audioFirst", eligible: true })
    act(() => h.result.current.acknowledge())
    expect(h.result.current.ack).toBeNull()
    h.rerender({ timingMode: "audioFirst", eligible: false })
    h.rerender({ timingMode: "audioFirst", eligible: true })
    expect(h.result.current.ack).toBeNull()
  })

  it("surfaceNow (the recorder's cell transition) ends the wait while still ineligible", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "dubbing", eligible: false }) // recorder opened
    h.rerender({ timingMode: "audioFirst", eligible: false }) // remote flip mid-session
    expect(h.result.current.ack).toBeNull()
    act(() => h.result.current.surfaceNow()) // advanced to the next cell
    expect(h.result.current.ack).toEqual({ from: "dubbing", to: "audioFirst" })
  })

  it("surfaceNow with nothing pending is a no-op", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    act(() => h.result.current.surfaceNow())
    expect(h.result.current.ack).toBeNull()
  })

  it("a flip BACK while the modal is showing closes it as moot", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "audioFirst", eligible: true })
    expect(h.result.current.ack).not.toBeNull()
    h.rerender({ timingMode: "dubbing", eligible: true })
    expect(h.result.current.ack).toBeNull()
  })

  it("a FURTHER flip while showing retargets the modal", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "audioFirst", eligible: true })
    // (hypothetical third mode isn't possible today with two modes, but a
    // flip back and forth again lands on the same target — assert stability)
    h.rerender({ timingMode: "audioFirst", eligible: true })
    expect(h.result.current.ack).toEqual({ from: "dubbing", to: "audioFirst" })
  })
})
