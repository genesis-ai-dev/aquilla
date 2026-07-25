// Round 6 (SUB-36): honest, movable dub chips — width from the recording,
// left from target_start_ms, overflow warnings, move-drag with snap+clamp.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import type { CellData } from "@/hooks/useCells"

function item(over: Partial<CellData> = {}, durationMs?: number, id = "c1"): TargetAudioItem {
  const takeId = `audio-${id}-1700000000-take.webm`
  const cell = {
    id, fileId: "f1", original: "", translated: "",
    medium: "media", startTime: 10, endTime: 20,
    selectedAudioId: takeId,
    attachments: {
      [takeId]: { type: "audio", url: "frontier-audio://take", ...(durationMs != null ? { durationMs } : {}) },
    },
    ...over,
  } as unknown as CellData
  return { cell, kind: "take", audioId: takeId }
}

const base = {
  pxPerSec: 40,
  viewStartSec: 0,
  viewEndSec: 100,
  selectedId: null,
  editable: true,
  snapEnabled: false,
  onSelect: () => {},
}

describe("TargetAudioLane — geometry", () => {
  it("chip width = the recording's duration; left = the section start by default", () => {
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} />)
    const chip = screen.getByTestId("tl-target-c1")
    expect(parseFloat(chip.style.left)).toBeCloseTo(10 * 40)
    expect(parseFloat(chip.style.width)).toBeCloseTo(4 * 40)
  })

  it("unknown duration falls back to the section width", () => {
    render(<TargetAudioLane {...base} items={[item()]} />)
    expect(parseFloat(screen.getByTestId("tl-target-c1").style.width)).toBeCloseTo(10 * 40)
  })

  it("a moved chip (target_start_ms) renders at its own start", () => {
    render(<TargetAudioLane {...base} items={[item({ metadata: { target_start_ms: 14000 } }, 4000)]} />)
    expect(parseFloat(screen.getByTestId("tl-target-c1").style.left)).toBeCloseTo(14 * 40)
  })
})

describe("TargetAudioLane — overflow warnings", () => {
  it("no overflow → data-overflow=none", () => {
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "none")
  })

  it("a long dub past the section end → soft (amber)", () => {
    render(<TargetAudioLane {...base} items={[item({}, 12000)]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "soft")
  })

  it("a dub reaching the NEXT section's chip → cutoff (red)", () => {
    const first = item({}, 12500) // [10, 22.5]
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 4000, "c2") // chip at 20
    render(<TargetAudioLane {...base} items={[first, second]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "cutoff")
    expect(screen.getByTestId("tl-target-c2")).toHaveAttribute("data-overflow", "none")
  })
})

describe("TargetAudioLane — interaction", () => {
  it("clean click selects and seeks", () => {
    const onSelect = vi.fn()
    const onSeek = vi.fn()
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} onSelect={onSelect} onSeek={onSeek} />)
    fireEvent.click(screen.getByTestId("tl-target-c1"))
    expect(onSelect).toHaveBeenCalledWith("c1")
    expect(onSeek).toHaveBeenCalledWith("c1")
  })

  it("dragging commits the new start (clamped into the section) and suppresses the seek", () => {
    const onRetimeTarget = vi.fn()
    const onSeek = vi.fn()
    render(
      <TargetAudioLane {...base} items={[item({}, 4000)]} onRetimeTarget={onRetimeTarget} onSeek={onSeek} />,
    )
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 260 }) // +160px = +4s → start 14
    fireEvent.pointerUp(window, { clientX: 260 })
    fireEvent.click(chip)
    expect(onRetimeTarget).toHaveBeenCalledTimes(1)
    const [, start] = onRetimeTarget.mock.calls[0] as [string, number]
    expect(start).toBeCloseTo(14)
    expect(onSeek).not.toHaveBeenCalled()
  })

  it("a drag past the section end clamps the start inside the section", () => {
    const onRetimeTarget = vi.fn()
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} onRetimeTarget={onRetimeTarget} />)
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 1100 }) // +25s → way past section end 20
    fireEvent.pointerUp(window, { clientX: 1100 })
    const [, start] = onRetimeTarget.mock.calls[0] as [string, number]
    expect(start).toBeCloseTo(20 - 0.05)
  })

  it("snap ON: a near-neighbor edge magnets the chip flush", () => {
    const onRetimeTarget = vi.fn()
    const first = item({}, 4000) // section [10,20], chip [10,14]
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 4000, "c2")
    render(
      <TargetAudioLane {...base} snapEnabled items={[first, second]} onRetimeTarget={onRetimeTarget} />,
    )
    const chip = screen.getByTestId("tl-target-c1")
    // +236px = +5.9s → chip [15.9, 19.9]; end 19.9 is within 0.2s of c2's
    // chip start (20) → snaps to end=20 → start 16.
    fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 336 })
    fireEvent.pointerUp(window, { clientX: 336 })
    const [, start] = onRetimeTarget.mock.calls[0] as [string, number]
    expect(start).toBeCloseTo(16)
  })

  it("not editable → no drag commit", () => {
    const onRetimeTarget = vi.fn()
    render(
      <TargetAudioLane {...base} editable={false} items={[item({}, 4000)]} onRetimeTarget={onRetimeTarget} />,
    )
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 260 })
    fireEvent.pointerUp(window, { clientX: 260 })
    expect(onRetimeTarget).not.toHaveBeenCalled()
  })
})

describe("TargetAudioLane — windowing", () => {
  it("windows by the CHIP span, not the section", () => {
    // Section [10,20] but chip moved to [18,22] — with a view of [21,40] the
    // chip still renders (its tail is inside the window).
    render(
      <TargetAudioLane
        {...base}
        viewStartSec={21}
        viewEndSec={40}
        items={[item({ metadata: { target_start_ms: 18000 } }, 4000)]}
      />,
    )
    expect(screen.getByTestId("tl-target-c1")).toBeInTheDocument()
  })
})

// Keep the round-5 basics honest too.
describe("TargetAudioLane — kinds", () => {
  it("take vs generated icons via data-kind", () => {
    const gen: TargetAudioItem = {
      ...item({ selectedAudioId: undefined, selectedGeneratedVoiceAudioId: "audio-c1-1700000001-gen.wav", attachments: { "audio-c1-1700000001-gen.wav": { type: "audio", url: "frontier-audio://gen", durationMs: 2000 } } } as Partial<CellData>),
      kind: "generated",
      audioId: "audio-c1-1700000001-gen.wav",
    }
    render(<TargetAudioLane {...base} items={[gen]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-kind", "generated")
  })
})
