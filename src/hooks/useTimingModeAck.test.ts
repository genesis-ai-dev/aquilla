// The remote timing-mode heads-up (2026-08-06): one seen-vs-current
// comparison instead of a notification queue. Deferral in the text view /
// while recording, surfacing on eligibility or the recorder's cell
// transition, and back-and-forth flips cancelling out.
//
// Pre-merge round: the mode is FILE-level, so "seen" is per file — switching
// files must never read as a remote change — and the changer stays mounted
// (the control is the toolbar now), so own-write suppression is explicit
// via noteOwnWrite.
import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useTimingModeAck } from "./useTimingModeAck"
import type { AudioTimingMode } from "@/lib/parsers/types"

type Props = { timingMode: AudioTimingMode; fileId: string | null; eligible: boolean }

function mount(initial: Partial<Props> & { timingMode: AudioTimingMode; eligible: boolean }) {
  const props: Props = { fileId: "f1", ...initial }
  return renderHook((p: Props) => useTimingModeAck(p), { initialProps: props })
}

describe("useTimingModeAck", () => {
  it("first eligibility baselines silently — no modal on first visit", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    expect(h.result.current.ack).toBeNull()
  })

  it("a remote change while eligible surfaces immediately", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true })
    expect(h.result.current.ack).toEqual({ from: "dubbing", to: "audioFirst" })
  })

  it("a change while in the TEXT VIEW waits, then surfaces on entering the media lens", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "dubbing", fileId: "f1", eligible: false }) // → text view
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: false }) // remote flip
    expect(h.result.current.ack).toBeNull()
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true }) // → media view
    expect(h.result.current.ack).toEqual({ from: "dubbing", to: "audioFirst" })
  })

  it("back-and-forth flips while deferred cancel out — nothing to say", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "dubbing", fileId: "f1", eligible: false })
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: false })
    h.rerender({ timingMode: "dubbing", fileId: "f1", eligible: false }) // flipped back
    h.rerender({ timingMode: "dubbing", fileId: "f1", eligible: true })
    expect(h.result.current.ack).toBeNull()
  })

  it("acknowledge closes and re-baselines — the same mode never re-surfaces", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true })
    act(() => h.result.current.acknowledge())
    expect(h.result.current.ack).toBeNull()
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: false })
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true })
    expect(h.result.current.ack).toBeNull()
  })

  it("surfaceNow (the recorder's cell transition) ends the wait while still ineligible", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "dubbing", fileId: "f1", eligible: false }) // recorder opened
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: false }) // remote flip mid-session
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
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true })
    expect(h.result.current.ack).not.toBeNull()
    h.rerender({ timingMode: "dubbing", fileId: "f1", eligible: true })
    expect(h.result.current.ack).toBeNull()
  })

  it("a FURTHER flip while showing retargets the modal", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true })
    // (hypothetical third mode isn't possible today with two modes, but a
    // flip back and forth again lands on the same target — assert stability)
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true })
    expect(h.result.current.ack).toEqual({ from: "dubbing", to: "audioFirst" })
  })

  // ── Pre-merge round: per-file memory ────────────────────────────────────

  it("switching FILES never reads as a remote change — each file baselines its own mode", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    // Switch to a Free-timing file: mode changes because the FILE changed.
    h.rerender({ timingMode: "audioFirst", fileId: "f2", eligible: true })
    expect(h.result.current.ack).toBeNull()
    // And back: still nothing — both files' modes are as last seen.
    h.rerender({ timingMode: "dubbing", fileId: "f1", eligible: true })
    expect(h.result.current.ack).toBeNull()
  })

  it("a remote change to a file seen EARLIER surfaces on returning to it", () => {
    const h = mount({ timingMode: "dubbing", eligible: true }) // f1 seen as dubbing
    h.rerender({ timingMode: "dubbing", fileId: "f2", eligible: true }) // over to f2
    // f1 changed remotely while f2 was open; returning to f1 shows it.
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true })
    expect(h.result.current.ack).toEqual({ from: "dubbing", to: "audioFirst" })
  })

  it("noteOwnWrite suppresses the modal for the changer's own click", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    act(() => h.result.current.noteOwnWrite("audioFirst")) // local toolbar click
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true }) // refresh lands
    expect(h.result.current.ack).toBeNull()
  })

  it("an open modal about a file that goes away closes as moot", () => {
    const h = mount({ timingMode: "dubbing", eligible: true })
    h.rerender({ timingMode: "audioFirst", fileId: "f1", eligible: true })
    expect(h.result.current.ack).not.toBeNull()
    h.rerender({ timingMode: "audioFirst", fileId: null, eligible: false })
    expect(h.result.current.ack).toBeNull()
  })
})
